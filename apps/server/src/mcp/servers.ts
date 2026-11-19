import type { McpRemoteTool, McpServer, McpServerInput } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { iso } from "../lib/time.js";
import type { RunTool } from "../runs/tools.js";
import { McpClient, modelToolName, toRemoteTool } from "./client.js";
import { toolResultText } from "./protocol.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

export interface McpServerRow {
  id: string;
  tenant_id: string;
  name: string;
  title: string;
  url: string;
  headers: string | null;
  header_names: string[];
  confirm: boolean;
  require_user: boolean;
  allowed_tools: string[] | null;
  enabled: boolean;
  tools: McpRemoteTool[];
  protocol_version: string | null;
  server_name: string | null;
  last_error: string | null;
  refreshed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const toMcpServer = (r: McpServerRow): McpServer => ({
  id: r.id,
  name: r.name,
  title: r.title,
  url: r.url,
  headerNames: r.header_names,
  confirm: r.confirm,
  requireUser: r.require_user,
  allowedTools: r.allowed_tools,
  enabled: r.enabled,
  tools: r.tools,
  protocolVersion: r.protocol_version,
  serverName: r.server_name,
  lastError: r.last_error,
  refreshedAt: r.refreshed_at ? iso(r.refreshed_at) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listMcpServers(sql: Tx, tenantId: string, ids?: string[]): Promise<McpServerRow[]> {
  return sql<McpServerRow[]>`
    SELECT * FROM mcp_servers WHERE tenant_id = ${tenantId}
    ${ids ? sql`AND id = ANY(${sql.array(ids)})` : sql``}
    ORDER BY created_at`;
}

export async function getMcpServer(sql: Tx, tenantId: string, id: string): Promise<McpServerRow | null> {
  const rows = await sql<McpServerRow[]>`SELECT * FROM mcp_servers WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

export async function createMcpServer(sql: Tx, key: Buffer, tenantId: string, a: McpServerInput): Promise<McpServerRow> {
  const names = Object.keys(a.headers);
  const rows = await sql<McpServerRow[]>`
    INSERT INTO mcp_servers (id, tenant_id, name, title, url, headers, header_names, confirm, require_user, allowed_tools, enabled)
    VALUES (${newId("mcp")}, ${tenantId}, ${a.name}, ${a.title}, ${a.url},
            ${names.length ? encrypt(key, JSON.stringify(a.headers)) : null}, ${sql.array(names)},
            ${a.confirm}, ${a.requireUser}, ${a.allowedTools ? sql.array(a.allowedTools) : null}, ${a.enabled})
    RETURNING *`;
  return rows[0]!;
}

export async function updateMcpServer(sql: Tx, key: Buffer, tenantId: string, id: string, p: Partial<McpServerInput>): Promise<McpServerRow | null> {
  const c = await getMcpServer(sql, tenantId, id);
  if (!c) return null;
  const headers = p.headers !== undefined ? (Object.keys(p.headers).length ? encrypt(key, JSON.stringify(p.headers)) : null) : c.headers;
  const headerNames = p.headers !== undefined ? Object.keys(p.headers) : c.header_names;
  const allowed = p.allowedTools !== undefined ? p.allowedTools : c.allowed_tools;
  const rows = await sql<McpServerRow[]>`
    UPDATE mcp_servers SET
      name = ${p.name ?? c.name}, title = ${p.title ?? c.title}, url = ${p.url ?? c.url},
      headers = ${headers}, header_names = ${sql.array(headerNames)},
      confirm = ${p.confirm ?? c.confirm}, require_user = ${p.requireUser ?? c.require_user},
      allowed_tools = ${allowed ? sql.array(allowed) : null}, enabled = ${p.enabled ?? c.enabled}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  return rows[0] ?? null;
}

export async function deleteMcpServer(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM mcp_servers WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
  if (rows.length) await sql`UPDATE assistants SET mcp_server_ids = array_remove(mcp_server_ids, ${id}) WHERE tenant_id = ${tenantId}`;
  return rows.length > 0;
}

export interface McpDeps {
  sql: Sql;
  key: Buffer;
  allowPrivate: boolean;
  version: string;
}

/**
 * Connected clients, reused across runs. Keyed by server id + updated_at so an
 * edit (new URL or headers) never reuses an old connection.
 */
const clients = new Map<string, { client: McpClient; expires: number }>();
const CLIENT_TTL_MS = 10 * 60_000;

function clientFor(d: McpDeps, row: McpServerRow): McpClient {
  const cacheKey = `${row.id}:${row.updated_at.getTime()}`;
  const hit = clients.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.client;
  for (const [k, v] of clients) if (k.startsWith(`${row.id}:`) || v.expires <= Date.now()) clients.delete(k);
  const client = new McpClient({
    url: row.url,
    headers: row.headers ? (JSON.parse(decrypt(d.key, row.headers)) as Record<string, string>) : {},
    allowPrivate: d.allowPrivate,
    clientVersion: d.version,
  });
  clients.set(cacheKey, { client, expires: Date.now() + CLIENT_TTL_MS });
  return client;
}

/** Connect, list tools and cache them on the row. Never throws: the error is stored instead. */
export async function refreshMcpServer(d: McpDeps, row: McpServerRow, signal?: AbortSignal): Promise<McpServerRow> {
  const client = clientFor(d, row);
  try {
    const tools = (await client.listTools(signal ?? AbortSignal.timeout(30_000))).map(toRemoteTool);
    const rows = await d.sql<McpServerRow[]>`
      UPDATE mcp_servers SET tools = ${d.sql.json(tools as never)}, protocol_version = ${client.protocolVersion},
        server_name = ${client.serverName}, last_error = NULL, refreshed_at = now()
      WHERE id = ${row.id} RETURNING *`;
    return rows[0] ?? row;
  } catch (err) {
    clients.delete(`${row.id}:${row.updated_at.getTime()}`);
    const rows = await d.sql<McpServerRow[]>`
      UPDATE mcp_servers SET last_error = ${describeError(err).slice(0, 500)}, refreshed_at = now()
      WHERE id = ${row.id} RETURNING *`;
    return rows[0] ?? row;
  }
}

/** undici reports "fetch failed" and hides the reason in `cause`. */
export function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const cause = e.cause?.code ?? e.cause?.message;
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message;
}

const STALE_MS = 6 * 3600_000;

/** Turn the cached tools of the given servers into run tools. Stale caches refresh in the background. */
export function mcpRunTools(d: McpDeps & { log: { warn: (o: object, m: string) => void } }, rows: McpServerRow[], signedIn: boolean): RunTool[] {
  const out: RunTool[] = [];
  for (const row of rows) {
    if (!row.enabled || (row.require_user && !signedIn)) continue;
    if (!row.refreshed_at || Date.now() - row.refreshed_at.getTime() > STALE_MS) {
      void refreshMcpServer(d, row).catch((err) => d.log.warn({ err, server: row.id }, "mcp refresh failed"));
    }
    const allowed = row.allowed_tools ? new Set(row.allowed_tools) : null;
    for (const t of row.tools) {
      if (allowed && !allowed.has(t.name)) continue;
      out.push({
        def: { name: modelToolName(row.name, t.name), description: `${t.description}\n(From ${row.title}.)`.trim(), parameters: t.inputSchema },
        title: t.title ?? `${row.title}: ${t.name.replace(/[_-]+/g, " ")}`,
        kind: "mcp",
        confirm: row.confirm && !t.readOnly,
        run: async (input, signal) => {
          const r = await clientFor(d, row).callTool(t.name, input, signal);
          return { content: toolResultText(r) || (r.isError ? "error" : "(no content)"), isError: Boolean(r.isError) };
        },
      });
    }
  }
  return out;
}
