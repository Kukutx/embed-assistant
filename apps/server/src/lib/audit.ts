/**
 * Audit log: an append-only record of every successful change made through
 * the admin API, plus sensitive reads (conversation exports).
 *
 * Entries are written by one middleware, so new admin routes are covered
 * without extra code. The request body is stored as the "changes", with
 * secret values redacted and long text shortened. Entries can be listed via
 * `GET /v1/admin/audit-log` and streamed to a SIEM with the `audit.recorded`
 * webhook event. There is no API to edit or delete them; the retention job
 * removes entries older than AUDIT_RETENTION_DAYS.
 */
import type { MiddlewareHandler } from "hono";
import type { AuditEvent } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import type { AppEnv, Services } from "../http/env.js";
import { emitWebhook } from "../webhooks/webhooks.js";
import { newId } from "./ids.js";
import { activeTraceIds } from "./telemetry.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

const VERBS: Record<string, string> = { POST: "create", PUT: "upsert", PATCH: "update", DELETE: "delete", GET: "read" };

/**
 * Names for routes whose generic name would be unclear. Keys are `METHOD route` below /v1/admin;
 * values are a name, or [name, path parameter that identifies the target].
 */
const NAMED: Record<string, string | [string, string]> = {
  "POST /sources/:id/files": "documents.upload",
  "DELETE /subjects/:subjectId": "subjects.erase",
  "DELETE /keys/:id": "keys.revoke",
  "GET /conversations/export": "conversations.export",
  "POST /logout": "auth.logout",
  "POST /evals/:id/runs": "evals.run",
  "POST /evals/:id/cases": "eval-cases.create",
  "PATCH /evals/:id/cases/:caseId": "eval-cases.update",
  "DELETE /evals/:id/cases/:caseId": "eval-cases.delete",
  "POST /assistants/:id/versions/:version/restore": ["assistants.restore-version", "id"],
};

/** Sensitive reads that are audited like changes. */
const AUDITED_READS = new Set(["GET /conversations/export"]);

export interface AuditAction {
  action: string;
  targetType: string;
  /** Name of the path parameter that identifies the target, if any. */
  targetParam: string | null;
}

/**
 * Derive a stable dotted action name from a route:
 * `PATCH /v1/admin/widgets/:id` -> `widgets.update`,
 * `POST /v1/admin/widgets/:id/rotate-secret` -> `widgets.rotate-secret`,
 * `PUT /v1/admin/sources/:id/documents` -> `documents.upsert`.
 */
export function auditAction(method: string, routePath: string): AuditAction | null {
  if (!routePath.startsWith("/v1/admin/")) return null;
  const rel = routePath.slice("/v1/admin".length);
  const key = `${method} ${rel}`;
  if (method === "GET" && !AUDITED_READS.has(key)) return null;
  const segs = rel.split("/").filter(Boolean);
  const params = segs.filter((x) => x.startsWith(":"));
  const lastParam = params.length ? params[params.length - 1]!.slice(1) : null;
  const named = NAMED[key];
  if (named) {
    const [action, target] = typeof named === "string" ? [named, lastParam] : named;
    return { action, targetType: action.split(".")[0]!, targetParam: target };
  }
  const last = segs[segs.length - 1]!;
  const prev = segs[segs.length - 2];
  // An operation on one resource: POST /things/:id/<operation>.
  if (method === "POST" && !last.startsWith(":") && prev?.startsWith(":")) {
    const resource = segs[segs.length - 3]!;
    return { action: `${resource}.${last}`, targetType: resource, targetParam: lastParam };
  }
  const resource = [...segs].reverse().find((x) => !x.startsWith(":"))!;
  const verb = VERBS[method] ?? method.toLowerCase();
  // Only a trailing parameter names the target; `PUT /sources/:id/documents` targets a new document.
  return { action: `${resource}.${verb}`, targetType: resource, targetParam: last.startsWith(":") ? last.slice(1) : null };
}

const SECRET_KEY = /secret|token|password|passwd|authorization|api[-_]?key|credential|cookie|private[-_]?key/i;
const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_JSON = 16 * 1024;

/** Copy of a request body that is safe to keep: secrets redacted, long values shortened. */
export function redactForAudit(value: unknown, depth = 0, parentKey = ""): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (typeof value !== "object") return value;
  if (depth >= 6) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redactForAudit(v, depth + 1, parentKey));
    return value.length > MAX_ITEMS ? [...items, `… (${value.length} items)`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Header maps (actions, MCP servers) carry credentials under arbitrary names.
    const hidden = SECRET_KEY.test(k) || /^headers$/i.test(parentKey);
    out[k] = hidden && v !== null && v !== "" ? "[redacted]" : redactForAudit(v, depth + 1, k);
  }
  return out;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  method: string;
  route: string;
  target_type: string;
  target_id: string | null;
  status: number;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  trace_id: string | null;
  changes: unknown;
}

export const toAuditEvent = (r: AuditRow): AuditEvent => ({
  id: r.id,
  at: r.at.toISOString(),
  actor: { type: r.actor_type as "api_key" | "user" | "system", id: r.actor_id, name: r.actor_name },
  action: r.action,
  method: r.method,
  route: r.route,
  target: { type: r.target_type, id: r.target_id },
  status: r.status,
  ip: r.ip,
  userAgent: r.user_agent,
  requestId: r.request_id,
  traceId: r.trace_id,
  changes: r.changes ?? null,
});

export type AuditInput = Omit<AuditRow, "id" | "at">;

export async function recordAudit(sql: Tx, e: AuditInput): Promise<AuditRow> {
  const [row] = await sql<AuditRow[]>`
    INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, actor_name, action, method, route, target_type, target_id,
                           status, ip, user_agent, request_id, trace_id, changes)
    VALUES (${newId("aud")}, ${e.tenant_id}, ${e.actor_type}, ${e.actor_id}, ${e.actor_name}, ${e.action}, ${e.method}, ${e.route},
            ${e.target_type}, ${e.target_id}, ${e.status}, ${e.ip}, ${e.user_agent}, ${e.request_id}, ${e.trace_id},
            ${e.changes === null || e.changes === undefined ? null : sql.json(e.changes as never)})
    RETURNING *`;
  await emitWebhook(sql, e.tenant_id, "audit.recorded", toAuditEvent(row!));
  return row!;
}

export interface AuditQuery {
  limit: number;
  cursor?: string | undefined;
  action?: string | undefined;
  targetId?: string | undefined;
  actorId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** Newest first. `action` matches exactly or by prefix (`widgets.` or `widgets`). */
export async function listAudit(sql: Sql, tenantId: string, q: AuditQuery): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  const action = q.action ? (q.action.endsWith(".") ? q.action : q.action.includes(".") ? q.action : `${q.action}.`) : null;
  const rows = await sql<AuditRow[]>`
    SELECT * FROM audit_log
    WHERE tenant_id = ${tenantId}
      ${q.cursor ? sql`AND id < ${q.cursor}` : sql``}
      ${action ? (action.endsWith(".") ? sql`AND action LIKE ${`${action.replace(/[%_\\]/g, "\\$&")}%`}` : sql`AND action = ${action}`) : sql``}
      ${q.targetId ? sql`AND target_id = ${q.targetId}` : sql``}
      ${q.actorId ? sql`AND actor_id = ${q.actorId}` : sql``}
      ${q.from ? sql`AND at >= ${q.from}::timestamptz` : sql``}
      ${q.to ? sql`AND at < ${q.to}::timestamptz` : sql``}
    ORDER BY id DESC
    LIMIT ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const items = more ? rows.slice(0, q.limit) : rows;
  return { items, nextCursor: more ? items[items.length - 1]!.id : null };
}

export async function purgeAudit(sql: Sql, days: number): Promise<number> {
  if (days <= 0) return 0;
  const rows = await sql`DELETE FROM audit_log WHERE at < now() - make_interval(days => ${days}) RETURNING 1`;
  return rows.length;
}

/** Id of a resource created by a request, read from its JSON response. */
async function createdId(res: Response): Promise<string | null> {
  if (res.status !== 201 || !res.headers.get("content-type")?.includes("application/json")) return null;
  try {
    const j = (await res.clone().json()) as Record<string, { id?: unknown } | unknown>;
    for (const v of [j, j.widget, j.apiKey, j.webhook, j.action, j.source]) {
      const id = (v as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") return id;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Records successful admin changes. Mount after admin authentication. */
export function auditTrail(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const status = c.res.status;
    if (status < 200 || status >= 300) return;
    const a = auditAction(c.req.method, c.req.routePath);
    const actor = c.get("actor");
    if (!a || !actor) return;
    try {
      let changes: unknown = null;
      const type = c.req.header("content-type") ?? "";
      if (type.includes("application/json")) {
        // The route already parsed the body; Hono caches it, so this does not read the stream again.
        changes = redactForAudit(await c.req.json().catch(() => null));
        if (JSON.stringify(changes ?? null).length > MAX_JSON) changes = { truncated: true };
      }
      const targetId = (a.targetParam ? c.req.param(a.targetParam) : null) ?? (await createdId(c.res));
      const ids = activeTraceIds();
      await recordAudit(s.sql, {
        tenant_id: actor.tenantId,
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.type === "user" ? (actor.email ?? actor.name) : actor.name,
        action: a.action,
        method: c.req.method,
        route: c.req.routePath.replace(/:(\w+)/g, "{$1}"),
        target_type: a.targetType,
        target_id: targetId ?? null,
        status,
        ip: c.get("clientIp") ?? null,
        user_agent: c.req.header("user-agent")?.slice(0, 300) ?? null,
        request_id: c.get("requestId") ?? null,
        trace_id: "trace_id" in ids ? ids.trace_id : null,
        changes,
      });
    } catch (err) {
      // The change itself is already committed; never turn it into an error response.
      s.log.error({ err, requestId: c.get("requestId") }, "audit log write failed");
    }
  };
}
