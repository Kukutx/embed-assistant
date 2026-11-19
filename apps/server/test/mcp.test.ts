/**
 * MCP server (/mcp) and MCP client (remote servers as assistant tools),
 * end to end against Postgres (TEST_DATABASE_URL).
 *
 * The app is served on a real port so the assistant can use this server's own
 * /mcp endpoint as a remote MCP server (modern, stateless protocol). A second,
 * hand-written server speaks the legacy protocol with sessions and SSE replies.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { createLogger } from "../src/lib/log.js";
import { McpClient, parseSseMessages } from "../src/mcp/client.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { createServices } from "../src/services.js";

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://app.example";
const V = "2026-07-28";

class ToolModel implements ChatModel {
  readonly id = "mcp-agent";
  readonly provider = "test";
  readonly model = "mcp-agent";
  requests: ChatRequest[] = [];
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    const has = (n: string) => req.tools?.some((t) => t.name === n);
    if (last.role === "tool") yield { type: "text", text: `Result: ${last.results.map((r) => `${r.isError ? "ERR " : ""}${r.content}`).join(" | ")}` };
    else if (/warranty via mcp/.test(req.question) && has("kb__search_knowledge")) {
      yield { type: "tool_call", call: { id: "tu_kb", name: "kb__search_knowledge", input: { query: "warranty period" } } };
    } else if (/weather/.test(req.question) && has("legacy__get_weather")) {
      yield { type: "tool_call", call: { id: "tu_wx", name: "legacy__get_weather", input: { city: "Rome" } } };
    } else yield { type: "text", text: `Answer: ${req.question} [1]` };
    yield { type: "usage", inputTokens: 3, outputTokens: 2 };
  }
}

describe.skipIf(!DB)("MCP (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let http: ServerType;
  let base: string;
  let legacy: Server;
  let legacyUrl: string;
  const legacyLog: { method: string; session: string | undefined; version: string | undefined }[] = [];
  let adminKey: string;
  let mcpKey: string;
  let staffKey: string;
  const model = new ToolModel();

  const rpc = (method: string, params: Record<string, unknown> = {}, o: { key?: string | null; headers?: Record<string, string>; modern?: boolean; id?: number | null } = {}) => {
    const modern = o.modern ?? true;
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      params: modern ? { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {} } } : params,
    };
    if (o.id !== null) body.id = o.id ?? 1;
    return app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(o.key === null ? {} : { authorization: `Bearer ${o.key ?? mcpKey}` }),
        ...(modern ? { "mcp-protocol-version": V, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}) } : {}),
        ...o.headers,
      },
      body: JSON.stringify(body),
    });
  };
  const admin = async (method: string, path: string, body?: unknown, status?: number) => {
    const r = await app.request(`/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const waitEvent = async (runId: string, type: string) => {
    for (let i = 0; i < 200; i++) {
      const rows = await sql<{ data: Record<string, any> }[]>`SELECT data FROM run_events WHERE run_id = ${runId} AND type = ${type} ORDER BY seq LIMIT 1`;
      if (rows[0]) return rows[0].data;
      await new Promise((r) => setTimeout(r, 50));
    }
    const all = await sql`SELECT type, data FROM run_events WHERE run_id = ${runId} ORDER BY seq`;
    throw new Error(`timed out waiting for ${type}: ${JSON.stringify(all)}`);
  };

  beforeAll(async () => {
    // Legacy (2025-06-18 style) server: initialize -> session id, SSE responses, 404 on unknown session.
    const sessions = new Set<string>();
    legacy = createServer((rq, rs) => {
      let raw = "";
      rq.on("data", (c) => (raw += c));
      rq.on("end", () => {
        const m = JSON.parse(raw) as { id?: number | string; method: string; params?: any };
        const session = rq.headers["mcp-session-id"] as string | undefined;
        legacyLog.push({ method: m.method, session, version: rq.headers["mcp-protocol-version"] as string | undefined });
        const sse = (result: unknown) => {
          rs.writeHead(200, { "content-type": "text/event-stream" });
          rs.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
          rs.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
          // Deliberately keep the stream open: the client must stop reading once it has its answer.
        };
        if (m.method === "initialize") {
          const id = `sess-${sessions.size + 1}`;
          sessions.add(id);
          rs.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
          return rs.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "weather", version: "0.1" } } }));
        }
        if (!session || !sessions.has(session)) {
          rs.writeHead(m.method === "server/discover" ? 400 : 404, { "content-type": "application/json" });
          return rs.end(JSON.stringify({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }));
        }
        if (m.method === "notifications/initialized") return rs.writeHead(202).end();
        if (m.method === "tools/list") {
          return sse({
            tools: [
              { name: "get_weather", description: "Current weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, annotations: { readOnlyHint: true } },
              { name: "delete.everything", description: "Not allowed.", inputSchema: { type: "object" } },
            ],
          });
        }
        if (m.method === "tools/call") {
          if (m.params.name === "get_weather") return sse({ content: [{ type: "text", text: `Sunny in ${m.params.arguments.city}` }], isError: false });
          return sse({ content: [{ type: "text", text: "no" }], isError: true });
        }
        rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }));
      });
    });
    await new Promise<void>((r) => legacy.listen(0, "127.0.0.1", r));
    legacyUrl = `http://127.0.0.1:${(legacy.address() as AddressInfo).port}/mcp`;

    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    base = `http://127.0.0.1:${port}`;
    const cfg = loadConfig({
      SECRET_KEY: "test-secret-key-0123456789abcdefghijkl",
      DATABASE_URL: DB,
      LOG_LEVEL: "silent",
      SERVE_WIDGET: "false",
      SERVE_CONSOLE: "false",
      PUBLIC_BASE_URL: base,
      OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true",
    });
    const models = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } });
    models.register(model, ["agent"]);
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    await s.bus.listen();
    app = createApp(s);
    http = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });

    const tenantId = await createTenant(sql, "MCP");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "test", k.hash, k.prefix);
    adminKey = k.key;
  });

  afterAll(async () => {
    legacy?.closeAllConnections?.();
    legacy?.close();
    http?.close();
    if (!sql) return;
    await s.executor.shutdown(5000);
    await sql.end({ timeout: 5 });
  });

  it("sets up knowledge and keys", async () => {
    const pub = await admin("POST", "/sources", { name: "Docs", type: "manual" }, 201);
    await admin("PUT", `/sources/${pub.id}/documents`, { title: "Warranty", url: "https://docs.example/warranty", content: "# Warranty\n\nThe warranty period is two years for all devices.\n\n## Claims\n\nSend the receipt to support." }, 200);
    const staff = await admin("POST", "/sources", { name: "Internal", type: "manual", access: ["staff"] }, 201);
    await admin("PUT", `/sources/${staff.id}/documents`, { title: "Escalations", content: "Escalate warranty disputes to the duty manager." }, 200);
    mcpKey = (await admin("POST", "/keys", { name: "ide", scopes: ["mcp"], access: ["public"] }, 201)).key;
    staffKey = (await admin("POST", "/keys", { name: "staff", scopes: ["mcp"], access: ["public", "staff"] }, 201)).key;
    expect(mcpKey).toMatch(/^ea_mcp_/);
    // mcp keys cannot use the admin API
    expect((await app.request("/v1/admin/assistants", { headers: { authorization: `Bearer ${mcpKey}` } })).status).toBe(401);
  });

  it("enforces transport rules", async () => {
    expect((await rpc("server/discover", {}, { key: null })).status).toBe(401);
    expect((await rpc("server/discover", {}, { key: "ea_mcp_wrong" })).status).toBe(401);
    expect((await rpc("server/discover", {}, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await rpc("server/discover", {}, { headers: { origin: base } })).status).toBe(200);
    expect((await app.request("/mcp", { method: "GET", headers: { authorization: `Bearer ${mcpKey}` } })).status).toBe(405);

    const mismatch = await rpc("tools/list", {}, { headers: { "mcp-method": "tools/call" } });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe(-32020);
    const noHeader = await rpc("tools/list", {}, { headers: { "mcp-protocol-version": "" } });
    expect((await noHeader.json()).error.code).toBe(-32020);
    const badVersion = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${mcpKey}`, "content-type": "application/json", "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }),
    });
    expect(badVersion.status).toBe(400);
    const bv = await badVersion.json();
    expect(bv.error.code).toBe(-32022);
    expect(bv.error.data).toMatchObject({ requested: "1900-01-01", supported: expect.arrayContaining([V, "2025-11-25"]) });

    const unknown = await rpc("resources/list");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe(-32601);
    expect((await rpc("notifications/cancelled", {}, { id: null })).status).toBe(202);
  });

  it("serves modern discovery, tools and calls", async () => {
    const d = await (await rpc("server/discover")).json();
    expect(d.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining([V]), capabilities: { tools: {} } });
    expect(d.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("embed-assistant");

    const list = await (await rpc("tools/list")).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_knowledge", "ask", "get_document", "list_sources"]);
    expect(list.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect(list.result.ttlMs).toBeGreaterThan(0);

    const hit = await (await rpc("tools/call", { name: "search_knowledge", arguments: { query: "warranty period" } })).json();
    expect(hit.result.isError).toBe(false);
    expect(hit.result.structuredContent.results[0]).toMatchObject({ title: "Warranty", url: "https://docs.example/warranty" });
    expect(hit.result.content[0].text).toContain("two years");
    expect(hit.result.content[0].text).not.toContain("duty manager"); // staff-only source

    const staffHit = await (await rpc("tools/call", { name: "search_knowledge", arguments: { query: "warranty disputes duty manager" } }, { key: staffKey })).json();
    expect(staffHit.result.content[0].text).toContain("duty manager");

    const sources = await (await rpc("tools/call", { name: "list_sources", arguments: {} })).json();
    expect(sources.result.content[0].text).toContain("Docs");
    expect(sources.result.content[0].text).not.toContain("Internal");

    const doc = await (await rpc("tools/call", { name: "get_document", arguments: { documentId: hit.result.structuredContent.results[0].documentId } })).json();
    expect(doc.result.content[0].text).toMatch(/# Warranty[\s\S]*Send the receipt/);

    const asked = await (await rpc("tools/call", { name: "ask", arguments: { question: "How long is the warranty?" } })).json();
    expect(asked.result.isError).toBe(true); // no assistant yet
    const bad = await (await rpc("tools/call", { name: "search_knowledge", arguments: {} })).json();
    expect(bad.result).toMatchObject({ isError: true });
    const missing = await rpc("tools/call", { name: "nope", arguments: {} });
    expect((await missing.json()).error.code).toBe(-32602);
    const nameMismatch = await rpc("tools/call", { name: "list_sources", arguments: {} }, { headers: { "mcp-name": "ask" } });
    expect((await nameMismatch.json()).error.code).toBe(-32020);
  });

  it("answers legacy clients (initialize, no session)", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } }, { modern: false });
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const r = (await init.json()).result;
    expect(r).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "embed-assistant" } });
    expect(r.resultType).toBeUndefined();
    const future = await (await rpc("initialize", { protocolVersion: "2099-01-01" }, { modern: false })).json();
    expect(future.result.protocolVersion).toBe("2025-11-25");
    expect((await rpc("notifications/initialized", {}, { modern: false, id: null })).status).toBe(202);
    const ping = await (await rpc("ping", {}, { modern: false, headers: { "mcp-protocol-version": "2025-06-18" } })).json();
    expect(ping.result).toEqual({});
    const list = await (await rpc("tools/list", {}, { modern: false, headers: { "mcp-protocol-version": "2025-06-18" } })).json();
    expect(list.result.tools).toHaveLength(4);
    expect(list.result.resultType).toBeUndefined();
  });

  it("client: talks to this server (modern) and to a legacy server", async () => {
    const modern = new McpClient({ url: `${base}/mcp`, headers: { authorization: `Bearer ${mcpKey}` }, allowPrivate: true, clientVersion: "test" });
    const tools = await modern.listTools();
    expect(modern.era).toBe("modern");
    expect(modern.protocolVersion).toBe(V);
    expect(tools.map((t) => t.name)).toContain("search_knowledge");
    const r = await modern.callTool("search_knowledge", { query: "warranty" });
    expect(r.content?.[0]?.text).toContain("two years");

    const old = new McpClient({ url: legacyUrl, headers: {}, allowPrivate: true, clientVersion: "test" });
    const lt = await old.listTools();
    expect(old.era).toBe("legacy");
    expect(old.protocolVersion).toBe("2025-06-18");
    expect(lt.map((t) => t.name)).toEqual(["get_weather", "delete.everything"]);
    expect((await old.callTool("get_weather", { city: "Oslo" })).content?.[0]?.text).toBe("Sunny in Oslo");
    const listCall = legacyLog.find((l) => l.method === "tools/list")!;
    expect(listCall.session).toBe("sess-1");
    expect(listCall.version).toBe("2025-06-18");
    expect(legacyLog.map((l) => l.method)).toContain("notifications/initialized");

    expect(parseSseMessages("event: message\ndata: {\"id\":1,\n\ndata: {\"id\":2,\"result\":{}}\n\n")).toEqual([{ id: 2, result: {} }]);
  });

  it("assistants use tools from remote MCP servers", async () => {
    await admin("POST", "/mcp-servers", { name: "Bad Name", title: "x", url: legacyUrl }, 400);
    const kb = await admin("POST", "/mcp-servers", { name: "kb", title: "Our docs", url: `${base}/mcp`, headers: { Authorization: `Bearer ${mcpKey}` }, confirm: false }, 201);
    expect(kb).toMatchObject({ protocolVersion: V, serverName: "embed-assistant knowledge", lastError: null, headerNames: ["Authorization"] });
    expect(JSON.stringify(kb)).not.toContain(mcpKey);
    expect(kb.tools.find((t: { name: string }) => t.name === "search_knowledge").readOnly).toBe(true);
    const wx = await admin("POST", "/mcp-servers", { name: "legacy", title: "Weather", url: legacyUrl, allowedTools: ["get_weather"] }, 201);
    expect(wx.protocolVersion).toBe("2025-06-18");
    expect(wx.confirm).toBe(true);
    await admin("POST", "/mcp-servers", { name: "kb", title: "dup", url: legacyUrl }, 409);
    const broken = await admin("POST", "/mcp-servers", { name: "down", title: "Down", url: "http://127.0.0.1:1/mcp" }, 201);
    expect(broken.lastError).toBeTruthy();
    expect((await admin("POST", `/mcp-servers/${wx.id}/test`, { tool: "get_weather", arguments: { city: "Paris" } }, 200)).output).toBe("Sunny in Paris");

    await admin("POST", "/assistants", { name: "x", mcpServerIds: ["mcp_missing"] }, 400);
    const a = await admin("POST", "/assistants", { name: "Agent", modelAlias: "agent", mcpServerIds: [kb.id, wx.id, broken.id] }, 201);
    const w = await admin("POST", "/widgets", { assistantId: a.id, name: "W", allowedOrigins: [ORIGIN] }, 201);
    const req = (method: string, path: string, token?: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { origin: ORIGIN, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    const token = (await (await req("POST", "/v1/sessions", undefined, { widgetId: w.widget.id, anonymousId: "mcp-test-abcdefghijklmnop" })).json()).token;
    const conv = (await (await req("POST", "/v1/conversations", token, {})).json()).id;

    // Read-only search on our own server: no confirmation.
    const run = (await (await req("POST", `/v1/conversations/${conv}/runs`, token, { content: "warranty via mcp?" })).json()).run;
    const done = await waitEvent(run.id, "message.completed");
    expect(done.message.content).toContain("two years");
    const sent = model.requests.find((r) => r.tools?.length)!.tools!.map((t) => t.name);
    expect(sent).toEqual(expect.arrayContaining(["kb__search_knowledge", "kb__ask", "legacy__get_weather"]));
    expect(sent).not.toContain("legacy__delete_everything");

    // Legacy server, confirm=true but the tool is read-only: runs directly.
    const run2 = (await (await req("POST", `/v1/conversations/${conv}/runs`, token, { content: "weather in Rome?" })).json()).run;
    const started = await waitEvent(run2.id, "tool.started");
    expect(started).toMatchObject({ name: "legacy__get_weather" });
    expect((await waitEvent(run2.id, "message.completed")).message.content).toContain("Sunny in Rome");

    // The MCP ask tool now has an assistant to answer with.
    const asked = await (await rpc("tools/call", { name: "ask", arguments: { question: "How long is the warranty?" } })).json();
    expect(asked.result.isError).toBe(false);
    expect(asked.result.structuredContent.answer).toContain("How long is the warranty?");

    await admin("DELETE", `/mcp-servers/${wx.id}`, undefined, 204);
    expect((await admin("GET", `/assistants/${a.id}`)).mcpServerIds).toEqual([kb.id, broken.id]);
  });
});
