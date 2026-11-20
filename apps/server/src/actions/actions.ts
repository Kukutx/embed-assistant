import { createHmac } from "node:crypto";
import type { Action, ActionInput } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { iso } from "../lib/time.js";
import { safeFetch } from "../knowledge/safeFetch.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

export interface ActionRow {
  id: string;
  tenant_id: string;
  name: string;
  title: string;
  description: string;
  parameters: Record<string, unknown>;
  method: Action["method"];
  url: string;
  headers: string | null;
  header_names: string[];
  confirm: boolean;
  require_user: boolean;
  timeout_ms: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export const toAction = (r: ActionRow): Action => ({
  id: r.id,
  name: r.name,
  title: r.title,
  description: r.description,
  parameters: r.parameters,
  method: r.method,
  url: r.url,
  headerNames: r.header_names,
  confirm: r.confirm,
  requireUser: r.require_user,
  timeoutMs: r.timeout_ms,
  enabled: r.enabled,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listActions(sql: Tx, tenantId: string, ids?: string[]): Promise<ActionRow[]> {
  return sql<ActionRow[]>`
    SELECT * FROM actions WHERE tenant_id = ${tenantId}
    ${ids ? sql`AND id = ANY(${ids})` : sql``}
    ORDER BY created_at`;
}

export async function getAction(sql: Tx, tenantId: string, id: string): Promise<ActionRow | null> {
  const rows = await sql<ActionRow[]>`SELECT * FROM actions WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

export async function createAction(sql: Tx, key: Buffer, tenantId: string, a: ActionInput): Promise<ActionRow> {
  const names = Object.keys(a.headers);
  const rows = await sql<ActionRow[]>`
    INSERT INTO actions (id, tenant_id, name, title, description, parameters, method, url, headers, header_names,
                         confirm, require_user, timeout_ms, enabled)
    VALUES (${newId("act")}, ${tenantId}, ${a.name}, ${a.title}, ${a.description}, ${sql.json(a.parameters as never)},
            ${a.method}, ${a.url}, ${names.length ? encrypt(key, JSON.stringify(a.headers)) : null}, ${names},
            ${a.confirm}, ${a.requireUser}, ${a.timeoutMs}, ${a.enabled})
    RETURNING *`;
  return rows[0]!;
}

export async function updateAction(sql: Tx, key: Buffer, tenantId: string, id: string, p: Partial<ActionInput>): Promise<ActionRow | null> {
  const c = await getAction(sql, tenantId, id);
  if (!c) return null;
  const headers = p.headers !== undefined ? (Object.keys(p.headers).length ? encrypt(key, JSON.stringify(p.headers)) : null) : c.headers;
  const headerNames = p.headers !== undefined ? Object.keys(p.headers) : c.header_names;
  const rows = await sql<ActionRow[]>`
    UPDATE actions SET
      name = ${p.name ?? c.name}, title = ${p.title ?? c.title}, description = ${p.description ?? c.description},
      parameters = ${sql.json((p.parameters ?? c.parameters) as never)}, method = ${p.method ?? c.method}, url = ${p.url ?? c.url},
      headers = ${headers}, header_names = ${headerNames}, confirm = ${p.confirm ?? c.confirm},
      require_user = ${p.requireUser ?? c.require_user}, timeout_ms = ${p.timeoutMs ?? c.timeout_ms},
      enabled = ${p.enabled ?? c.enabled}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  return rows[0] ?? null;
}

export async function deleteAction(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  return (await sql`DELETE FROM actions WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`).length > 0;
}

export interface ActionCaller {
  subjectId: string;
  subjectKind: "anonymous" | "user";
  name?: string | null | undefined;
  email?: string | null | undefined;
  groups?: string[] | undefined;
  conversationId?: string | undefined;
}

export interface ActionOutcome {
  status: number;
  isError: boolean;
  output: string;
  durationMs: number;
}

const MAX_OUTPUT = 16_000;

/** Build the outgoing request: `{name}` path placeholders, then query (GET/DELETE) or JSON body. */
export function buildActionRequest(method: string, template: string, args: Record<string, unknown>): { url: string; body: string | undefined } {
  const rest: Record<string, unknown> = { ...args };
  const url = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = rest[name];
    delete rest[name];
    return encodeURIComponent(v === undefined || v === null ? "" : String(v));
  });
  if (method === "GET" || method === "DELETE") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, typeof x === "object" ? JSON.stringify(x) : String(x)));
      else u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return { url: u.toString(), body: undefined };
  }
  return { url, body: JSON.stringify(rest) };
}

/**
 * Call an action endpoint. Every request is signed so the receiver can verify it
 * came from this assistant: `EA-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<METHOD>.<url>.<EA-User-Id>.<body>")>`,
 * where the secret is the widget's identity secret (the host backend already has it). The user id
 * part is empty when no user is forwarded, so a captured request cannot be replayed as another user.
 */
export async function callAction(
  a: ActionRow,
  args: Record<string, unknown>,
  o: { key: Buffer; signingSecret: string | null; caller: ActionCaller; allowPrivate: boolean },
): Promise<ActionOutcome> {
  const started = Date.now();
  const { url, body } = buildActionRequest(a.method, a.url, args);
  const headers: Record<string, string> = a.headers ? (JSON.parse(decrypt(o.key, a.headers)) as Record<string, string>) : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (o.caller.conversationId) headers["ea-conversation-id"] = o.caller.conversationId;
  if (a.require_user && o.caller.subjectKind === "user") {
    headers["ea-user-id"] = o.caller.subjectId;
    if (o.caller.email) headers["ea-user-email"] = o.caller.email;
    if (o.caller.name) headers["ea-user-name"] = encodeURIComponent(o.caller.name);
    if (o.caller.groups?.length) headers["ea-user-groups"] = o.caller.groups.join(",");
  }
  if (o.signingSecret) {
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", o.signingSecret).update(`${t}.${a.method}.${url}.${headers["ea-user-id"] ?? ""}.${body ?? ""}`).digest("hex");
    headers["ea-signature"] = `t=${t},v1=${mac}`;
  }
  try {
    const res = await safeFetch(url, {
      allowPrivate: o.allowPrivate,
      method: a.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: a.timeout_ms,
      maxBytes: 1024 * 1024,
      accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      userAgent: "embed-assistant-action/1.0",
    });
    const isError = res.status >= 400;
    let output = res.body.trim();
    if (/json/i.test(res.contentType)) {
      try {
        output = JSON.stringify(JSON.parse(output));
      } catch {
        /* keep raw */
      }
    }
    if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}… (truncated)`;
    return { status: res.status, isError, output: isError ? `HTTP ${res.status}: ${output.slice(0, 2000)}` : output, durationMs: Date.now() - started };
  } catch (err) {
    return { status: 0, isError: true, output: `request failed: ${(err as Error).message}`, durationMs: Date.now() - started };
  }
}
