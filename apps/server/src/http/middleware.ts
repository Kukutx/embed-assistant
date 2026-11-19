import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ErrorCode } from "@embed-assistant/protocol";
import { hashAdminKey, ADMIN_KEY_PREFIX } from "../auth/adminKey.js";
import { isOriginAllowed } from "../auth/origin.js";
import { findAdminKey, getWidgetById, type WidgetRow } from "../db/store.js";
import { ApiError, unauthorized } from "../lib/errors.js";
import { ulid } from "../lib/ids.js";
import { metrics } from "../lib/metrics.js";
import type { Sql } from "../db/pool.js";
import type { AppEnv, Services } from "./env.js";

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

/** Request id, client ip, access log, metrics. */
export function requestContext(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : ulid();
    c.set("requestId", requestId);
    c.set("clientIp", clientIp(c, s.cfg.TRUST_PROXY));
    const started = performance.now();
    await next();
    c.header("x-request-id", requestId);
    const ms = Math.round(performance.now() - started);
    const routePath = c.req.routePath || "unmatched";
    metrics.http.inc({ method: c.req.method, route: routePath, status: String(c.res.status) });
    if (routePath !== "/healthz" && routePath !== "/metrics") {
      s.log.info({ requestId, method: c.req.method, route: routePath, status: c.res.status, ms }, "request");
    }
  };
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * CORS for the public API. Any origin may *ask* (preflight); each handler then
 * enforces the widget's allowlist. Tokens travel in headers, never cookies,
 * so reflecting the origin does not expose ambient credentials.
 */
export function publicCors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin", { append: true });
      c.header("Access-Control-Expose-Headers", "x-request-id, retry-after");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "authorization, content-type, last-event-id, x-request-id");
      c.header("Access-Control-Max-Age", "600");
      return c.body(null, 204);
    }
    await next();
  };
}

/** Widgets are read on every chat request; a short cache keeps that off the database. */
export class WidgetCache {
  private readonly entries = new Map<string, { row: WidgetRow | null; at: number }>();
  constructor(
    private readonly sql: Sql,
    private readonly ttlMs = 5000,
  ) {}

  async get(id: string): Promise<WidgetRow | null> {
    const hit = this.entries.get(id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.row;
    const row = await getWidgetById(this.sql, id);
    if (this.entries.size > 10_000) this.entries.clear();
    this.entries.set(id, { row, at: Date.now() });
    return row;
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }
}

export function assertOrigin(c: Context, widget: WidgetRow): void {
  if (!isOriginAllowed(c.req.header("origin"), widget.allowed_origins)) {
    throw new ApiError(ErrorCode.OriginNotAllowed, "this website is not allowed to use this assistant");
  }
}

/** Chat endpoints: verify the session token, re-check the widget still exists and the origin. */
export function sessionAuth(s: Services, widgets: WidgetCache): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!token) throw unauthorized("missing session token");
    const claims = await s.sessions.verify(token);
    const widget = await widgets.get(claims.widgetId);
    if (!widget || widget.tenant_id !== claims.tenantId) throw unauthorized("session is no longer valid");
    assertOrigin(c, widget);
    c.set("session", claims);
    c.set("widget", widget);
    await next();
  };
}

export function adminAuth(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = bearer(c);
    if (!key || !key.startsWith(ADMIN_KEY_PREFIX)) throw unauthorized("missing admin key");
    const row = await findAdminKey(s.sql, hashAdminKey(key));
    if (!row) throw unauthorized("invalid admin key");
    c.set("tenantId", row.tenant_id);
    await next();
  };
}
