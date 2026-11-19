/**
 * Platform API: operators of a multi-tenant installation manage tenants.
 * Off unless PLATFORM_ADMIN_TOKEN is set. Every change is also written to the
 * affected tenant's audit log (actor type `system`), so tenants can see what
 * the operator did.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { CreatedApiKey, ErrorCode, CreatedTenant, PlatformKeyInput, Tenant, TenantInput, TenantList, TenantPatch, TenantStatus } from "@embed-assistant/protocol";
import { recordAudit } from "../../lib/audit.js";
import { safeEqual, sha256 } from "../../lib/crypto.js";
import { ApiError, conflict, notFound, unauthorized } from "../../lib/errors.js";
import { activeTraceIds } from "../../lib/telemetry.js";
import { createTenantWithKey, deleteTenant, getTenant, issueAdminKey, listTenants, toTenant, updateTenant } from "../../platform/tenants.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";
import { bearer } from "../middleware.js";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
  status: TenantStatus.optional(),
  externalId: z.string().max(200).optional(),
  /** Name contains (case-insensitive). */
  q: z.string().max(200).optional(),
});

export function platformAuth(s: Services): MiddlewareHandler<AppEnv> {
  const expected = s.cfg.PLATFORM_ADMIN_TOKEN ? sha256(s.cfg.PLATFORM_ADMIN_TOKEN) : null;
  return async (c, next) => {
    // Without a token the platform API does not exist (404, not 401: nothing to probe).
    if (!expected) throw new ApiError(ErrorCode.NotFound, "route not found");
    if (!safeEqual(sha256(bearer(c) ?? ""), expected)) throw unauthorized("invalid platform token");
    await next();
  };
}

export function platformRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const T = "Platform: tenants";

  const audit = (c: Context<AppEnv>, tenantId: string, action: string, status: number, changes: unknown = null) => {
    const ids = activeTraceIds();
    return recordAudit(sql, {
      tenant_id: tenantId,
      actor_type: "system",
      actor_id: null,
      actor_name: "platform operator",
      action,
      method: c.req.method,
      route: c.req.routePath,
      target_type: "tenant",
      target_id: tenantId,
      status,
      ip: c.get("clientIp") ?? null,
      user_agent: c.req.header("user-agent")?.slice(0, 300) ?? null,
      request_id: c.get("requestId") ?? null,
      trace_id: "trace_id" in ids ? ids.trace_id : null,
      changes,
    });
  };

  route(app, {
      method: "get", path: "/v1/platform/tenants", tag: T, summary: "List tenants (oldest first) with 30-day usage",
      auth: "platform", query: ListQuery, response: { status: 200, schema: TenantList },
    },
    async (c, { query }) => {
      const page = await listTenants(sql, query);
      return c.json({ items: page.items.map(toTenant), nextCursor: page.nextCursor });
    });

  route(app, {
      method: "post", path: "/v1/platform/tenants", tag: T, summary: "Create a tenant",
      description: "Returns the tenant and its first admin API key. The key is shown once; use it to configure the tenant or to invite its people.",
      auth: "platform", body: TenantInput, response: { status: 201, schema: CreatedTenant },
    },
    async (c, { body }) => {
      if (body.externalId) {
        const [dup] = await sql`SELECT id FROM tenants WHERE external_id = ${body.externalId}`;
        if (dup) throw conflict(`a tenant with externalId ${body.externalId} already exists (${dup.id})`);
      }
      const { tenant, key } = await createTenantWithKey(sql, body);
      await audit(c, tenant.id, "tenant.create", 201, { name: body.name, externalId: body.externalId, adminKeyName: body.adminKeyName });
      s.log.info({ tenant: tenant.id }, "platform: tenant created");
      return c.json({ tenant: toTenant((await getTenant(sql, tenant.id))!), adminKey: key }, 201);
    });

  route(app, { method: "get", path: "/v1/platform/tenants/{id}", tag: T, summary: "Get a tenant", auth: "platform", response: { status: 200, schema: Tenant } },
    async (c) => {
      const t = await getTenant(sql, param(c, "id"));
      if (!t) throw notFound("tenant");
      return c.json(toTenant(t));
    });

  route(app, {
      method: "patch", path: "/v1/platform/tenants/{id}", tag: T, summary: "Rename, relabel, suspend or reactivate a tenant",
      description: "A suspended tenant keeps its data, but its widgets, admin API, console sign-in and MCP endpoint stop working until it is reactivated.",
      auth: "platform", body: TenantPatch, response: { status: 200, schema: Tenant },
    },
    async (c, { body }) => {
      if (body.externalId) {
        const [dup] = await sql`SELECT id FROM tenants WHERE external_id = ${body.externalId} AND id <> ${param(c, "id")}`;
        if (dup) throw conflict(`a tenant with externalId ${body.externalId} already exists (${dup.id})`);
      }
      const before = await getTenant(sql, param(c, "id"));
      if (!before) throw notFound("tenant");
      const t = (await updateTenant(sql, before.id, body))!;
      const action = body.status && body.status !== before.status ? (body.status === "suspended" ? "tenant.suspend" : "tenant.reactivate") : "tenant.update";
      await audit(c, t.id, action, 200, body);
      if (action !== "tenant.update") s.log.warn({ tenant: t.id, status: t.status }, `platform: ${action}`);
      return c.json(toTenant(t));
    });

  route(app, {
      method: "delete", path: "/v1/platform/tenants/{id}", tag: T, summary: "Delete a tenant and all its data",
      description: "Permanent. The tenant must be suspended first (409 otherwise), so a single mistaken call cannot erase an active customer.",
      auth: "platform", response: { status: 204 },
    },
    async (c) => {
      const r = await deleteTenant(sql, param(c, "id"));
      if (r === "not_found") throw notFound("tenant");
      if (r === "active") throw conflict("suspend the tenant before deleting it");
      s.log.warn({ tenant: param(c, "id") }, "platform: tenant deleted");
      return c.body(null, 204);
    });

  route(app, {
      method: "post", path: "/v1/platform/tenants/{id}/keys", tag: T, summary: "Issue an admin API key for a tenant (recovery)",
      description: "For when a tenant lost access to its console: the new key holds every permission. It is recorded in the tenant's audit log.",
      auth: "platform", body: PlatformKeyInput, response: { status: 201, schema: CreatedApiKey },
    },
    async (c, { body }) => {
      const t = await getTenant(sql, param(c, "id"));
      if (!t) throw notFound("tenant");
      const k = await issueAdminKey(sql, t.id, body.name);
      await audit(c, t.id, "keys.create", 201, { name: body.name, by: "platform" });
      return c.json(
        {
          apiKey: { id: k.id, name: body.name, prefix: k.prefix, scopes: ["admin" as const], access: ["public"], createdAt: new Date().toISOString(), lastUsedAt: null },
          key: k.key,
        },
        201,
      );
    });
}
