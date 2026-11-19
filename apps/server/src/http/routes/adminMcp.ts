import type { Context, Hono } from "hono";
import { z } from "zod";
import { ErrorCode, McpServer, McpServerInput, McpServerPatch } from "@embed-assistant/protocol";
import { ApiError, notFound } from "../../lib/errors.js";
import { McpClient } from "../../mcp/client.js";
import { toolResultText } from "../../mcp/protocol.js";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  refreshMcpServer,
  toMcpServer,
  updateMcpServer,
  describeError,
  type McpDeps,
} from "../../mcp/servers.js";
import { decrypt } from "../../lib/crypto.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const tid = (c: Context<AppEnv>) => c.get("tenantId");
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";

const McpToolTest = z.object({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}) });
const McpToolTestResult = z.object({ isError: z.boolean(), output: z.string(), durationMs: z.number().int() });

export function adminMcpRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const A = "Admin";
  const deps: McpDeps = { sql, key: s.secretsKey, allowPrivate: s.cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS, version: s.version };

  route(app, { method: "get", path: "/v1/admin/mcp-servers", tag: A, summary: "List remote MCP servers", auth: "admin", response: { status: 200, schema: z.array(McpServer) } },
    async (c) => c.json((await listMcpServers(sql, tid(c))).map(toMcpServer)));

  route(app, {
      method: "post", path: "/v1/admin/mcp-servers", tag: A, summary: "Connect a remote MCP server",
      description:
        "Its tools become available to assistants that list it in mcpServerIds, named `<name>__<tool>`. " +
        "Streamable HTTP, protocol 2026-07-28 with fallback to 2025-03-26..2025-11-25. The tool list is fetched now and refreshed every few hours.",
      auth: "admin", body: McpServerInput, response: { status: 201, schema: McpServer },
    },
    async (c, { body }) => {
      try {
        const row = await createMcpServer(sql, s.secretsKey, tid(c), body);
        return c.json(toMcpServer(await refreshMcpServer(deps, row)), 201);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(ErrorCode.Conflict, `an MCP server named "${body.name}" already exists`);
        throw err;
      }
    });

  route(app, { method: "get", path: "/v1/admin/mcp-servers/{id}", tag: A, summary: "Get an MCP server", auth: "admin", response: { status: 200, schema: McpServer } },
    async (c) => {
      const row = await getMcpServer(sql, tid(c), param(c, "id"));
      if (!row) throw notFound("MCP server");
      return c.json(toMcpServer(row));
    });

  route(app, { method: "patch", path: "/v1/admin/mcp-servers/{id}", tag: A, summary: "Update an MCP server", auth: "admin", body: McpServerPatch, response: { status: 200, schema: McpServer } },
    async (c, { body }) => {
      try {
        const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        const row = await updateMcpServer(sql, s.secretsKey, tid(c), param(c, "id"), patch);
        if (!row) throw notFound("MCP server");
        const reconnect = body.url !== undefined || body.headers !== undefined;
        return c.json(toMcpServer(reconnect ? await refreshMcpServer(deps, row) : row));
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(ErrorCode.Conflict, "an MCP server with that name already exists");
        throw err;
      }
    });

  route(app, { method: "delete", path: "/v1/admin/mcp-servers/{id}", tag: A, summary: "Remove an MCP server", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteMcpServer(sql, tid(c), param(c, "id")))) throw notFound("MCP server");
      return c.body(null, 204);
    });

  route(app, { method: "post", path: "/v1/admin/mcp-servers/{id}/refresh", tag: A, summary: "Reconnect and reload the tool list", auth: "admin", response: { status: 200, schema: McpServer } },
    async (c) => {
      const row = await getMcpServer(sql, tid(c), param(c, "id"));
      if (!row) throw notFound("MCP server");
      return c.json(toMcpServer(await refreshMcpServer(deps, row)));
    });

  route(app, { method: "post", path: "/v1/admin/mcp-servers/{id}/test", tag: A, summary: "Call one of the server's tools", auth: "admin", body: McpToolTest, response: { status: 200, schema: McpToolTestResult } },
    async (c, { body }) => {
      const row = await getMcpServer(sql, tid(c), param(c, "id"));
      if (!row) throw notFound("MCP server");
      const client = new McpClient({
        url: row.url,
        headers: row.headers ? (JSON.parse(decrypt(s.secretsKey, row.headers)) as Record<string, string>) : {},
        allowPrivate: deps.allowPrivate,
        clientVersion: s.version,
      });
      const started = Date.now();
      try {
        const r = await client.callTool(body.tool, body.arguments, AbortSignal.timeout(30_000));
        return c.json({ isError: Boolean(r.isError), output: toolResultText(r), durationMs: Date.now() - started });
      } catch (err) {
        return c.json({ isError: true, output: describeError(err), durationMs: Date.now() - started });
      }
    });
}
