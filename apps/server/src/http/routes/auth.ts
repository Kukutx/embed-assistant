/**
 * Console sign-in with OpenID Connect, console users and roles, SSO settings.
 *
 * Browser flow: /auth/oidc/start -> identity provider -> /auth/oidc/callback,
 * which redirects to the console with a one-time code; the console exchanges
 * it at POST /auth/session for a bearer session token (`ea_cs_...`) that it
 * sends to the admin API like an API key. The admin API never uses cookies,
 * so it needs no CSRF protection; the only cookie is the short-lived, signed
 * sign-in state scoped to /auth/oidc.
 */
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { ConsoleLogin, ConsoleUser, ConsoleUserInput, ConsoleUserPatch, Me, SsoConfig, SsoConfigInput } from "@embed-assistant/protocol";
import {
  createLoginCode,
  createUser,
  deleteUser,
  enabledSsoTenants,
  endSession,
  getSso,
  getUser,
  listUsers,
  putSso,
  redeemLoginCode,
  resolveLogin,
  ssoClientSecret,
  ssoRedirectUri,
  toConsoleUser,
  toSsoConfig,
  updateUser,
} from "../../auth/console.js";
import { authorizationUrl, completeLogin, discover, newAuthRequest, OidcError, type AuthRequest } from "../../auth/oidc.js";
import { canManageRole, permissionsOf } from "../../auth/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { deriveKey } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { activeTraceIds } from "../../lib/telemetry.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const STATE_COOKIE = "ea_oidc";
const STATE_PATH = "/auth/oidc";

interface PendingLogin extends AuthRequest {
  tenantId: string;
}

export function authRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql, cfg } = s;
  const stateKey = new Uint8Array(deriveKey(cfg.SECRET_KEY, "oidc-state"));
  const redirectUri = ssoRedirectUri(cfg.PUBLIC_BASE_URL);
  const secure = cfg.PUBLIC_BASE_URL.startsWith("https://");
  const allowPrivate = cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS;
  const consoleUrl = (fragment: Record<string, string>) => `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/admin/#/login?${new URLSearchParams(fragment)}`;

  const audit = (c: Context<AppEnv>, tenantId: string, action: string, actor: { id: string | null; name: string | null }, changes: unknown = null) => {
    const ids = activeTraceIds();
    return recordAudit(sql, {
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: actor.id,
      actor_name: actor.name,
      action,
      method: c.req.method,
      route: c.req.routePath,
      target_type: "users",
      target_id: actor.id,
      status: 200,
      ip: c.get("clientIp") ?? null,
      user_agent: c.req.header("user-agent")?.slice(0, 300) ?? null,
      request_id: c.get("requestId") ?? null,
      trace_id: "trace_id" in ids ? ids.trace_id : null,
      changes,
    }).catch((err: unknown) => s.log.error({ err }, "audit log write failed"));
  };

  // ------------------------------------------------------------------ public sign-in endpoints
  route(app, {
      method: "get", path: "/auth/sso", tag: "Console sign-in", summary: "Whether single sign-on is available",
      description: "`tenantRequired` is true when several tenants use SSO; pass `?tenant=` to /auth/oidc/start then.",
      auth: "none", response: { status: 200, schema: z.object({ enabled: z.boolean(), tenantRequired: z.boolean() }) },
    },
    async (c) => {
      const t = await enabledSsoTenants(sql);
      return c.json({ enabled: t.length > 0, tenantRequired: t.length > 1 });
    });

  app.get("/auth/oidc/start", async (c) => {
    try {
      let tenantId = c.req.query("tenant")?.trim();
      if (!tenantId) {
        const t = await enabledSsoTenants(sql);
        if (t.length !== 1) throw new OidcError(t.length ? "choose your organization (tenant id)" : "single sign-on is not set up");
        tenantId = t[0]!;
      }
      const sso = await getSso(sql, tenantId);
      if (!sso?.enabled) throw new OidcError("single sign-on is not set up for this organization");
      const meta = await discover(sso.issuer, allowPrivate);
      const req = newAuthRequest();
      const pending: PendingLogin = { ...req, tenantId };
      const jwt = await new SignJWT({ ...pending }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(stateKey);
      setCookie(c, STATE_COOKIE, jwt, { path: STATE_PATH, httpOnly: true, secure, sameSite: "Lax", maxAge: 600 });
      const hint = c.req.query("login_hint");
      return c.redirect(authorizationUrl(meta, { clientId: sso.client_id, redirectUri, req, loginHint: hint && hint.length <= 320 ? hint : undefined }), 302);
    } catch (err) {
      return c.redirect(consoleUrl({ error: err instanceof OidcError ? err.message : "single sign-on is unavailable" }), 302);
    }
  });

  app.get("/auth/oidc/callback", async (c) => {
    const raw = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: STATE_PATH, secure });
    const fail = (message: string) => c.redirect(consoleUrl({ error: message }), 302);
    let pending: PendingLogin;
    try {
      if (!raw) return fail("the sign-in took too long or was started in another browser; try again");
      pending = (await jwtVerify(raw, stateKey, { algorithms: ["HS256"] })).payload as unknown as PendingLogin;
    } catch {
      return fail("the sign-in expired; try again");
    }
    if (c.req.query("state") !== pending.state) return fail("the sign-in could not be verified (state mismatch); try again");
    const idpError = c.req.query("error");
    if (idpError) return fail(`your identity provider refused the sign-in: ${(c.req.query("error_description") ?? idpError).slice(0, 200)}`);
    const code = c.req.query("code");
    if (!code) return fail("no authorization code was returned");
    try {
      const sso = await getSso(sql, pending.tenantId);
      if (!sso?.enabled) return fail("single sign-on is not set up for this organization");
      const meta = await discover(sso.issuer, allowPrivate);
      const identity = await completeLogin(meta, {
        clientId: sso.client_id,
        clientSecret: ssoClientSecret(s.secretsKey, sso),
        redirectUri,
        code,
        req: pending,
        allowPrivate,
      });
      const result = await resolveLogin(sql, sso, identity);
      if (!result.ok) {
        await audit(c, sso.tenant_id, "auth.login-denied", { id: null, name: identity.email ?? identity.subject }, { reason: result.reason });
        return fail(result.reason);
      }
      await audit(c, sso.tenant_id, "auth.login", { id: result.user.id, name: result.user.email });
      return c.redirect(consoleUrl({ code: await createLoginCode(sql, result.user.id) }), 302);
    } catch (err) {
      if (!(err instanceof OidcError)) s.log.error({ err }, "single sign-on failed");
      return fail(err instanceof OidcError ? err.message : "single sign-on failed");
    }
  });

  route(app, {
      method: "post", path: "/auth/session", tag: "Console sign-in", summary: "Exchange a one-time sign-in code for a console session token",
      auth: "none", body: z.object({ code: z.string().min(10).max(200) }), response: { status: 200, schema: ConsoleLogin },
    },
    async (c, { body }) => {
      const r = await redeemLoginCode(sql, body.code, cfg.CONSOLE_SESSION_HOURS, { ip: c.get("clientIp") ?? null, userAgent: c.req.header("user-agent") ?? null });
      if (!r) throw unauthorized("this sign-in link has expired; sign in again");
      return c.json({ token: r.token, expiresAt: r.expiresAt.toISOString(), user: toConsoleUser(r.user) });
    });

  // ------------------------------------------------------------------ who am I
  const A = "Admin: team";
  route(app, { method: "get", path: "/v1/admin/me", tag: A, summary: "The caller: API key or console user, role and permissions", auth: "admin", response: { status: 200, schema: Me } },
    async (c) => {
      const a = c.get("actor");
      return c.json({ type: a.type, id: a.id, name: a.name, email: a.email, role: a.role, permissions: permissionsOf(a.role), tenantId: a.tenantId });
    });

  route(app, { method: "post", path: "/v1/admin/logout", tag: A, summary: "End the console session", auth: "admin", response: { status: 204 } },
    async (c) => {
      const token = c.get("consoleToken");
      if (token) await endSession(sql, token);
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ users
  route(app, { method: "get", path: "/v1/admin/users", tag: A, summary: "List console users", auth: "admin", response: { status: 200, schema: z.array(ConsoleUser) } },
    async (c) => c.json((await listUsers(sql, c.get("tenantId"))).map(toConsoleUser)));

  route(app, {
      method: "post", path: "/v1/admin/users", tag: A, summary: "Invite a console user",
      description: "The person signs in with single sign-on using this e-mail address.",
      auth: "admin", body: ConsoleUserInput, response: { status: 201, schema: ConsoleUser },
    },
    async (c, { body }) => {
      if (!canManageRole(c.get("actor").role, body.role)) throw forbidden("only owners can add owners");
      const u = await createUser(sql, c.get("tenantId"), body);
      if (!u) throw conflict("a user with this e-mail already exists");
      return c.json(toConsoleUser(u), 201);
    });

  const manageable = async (c: Context<AppEnv>) => {
    const actor = c.get("actor");
    const u = await getUser(sql, c.get("tenantId"), param(c, "id"));
    if (!u) throw notFound("user");
    if (actor.type === "user" && u.id === actor.id) throw badRequest("you cannot change or remove yourself; ask another administrator");
    if (!canManageRole(actor.role, u.role)) throw forbidden("only owners can manage owners");
    return u;
  };

  route(app, { method: "patch", path: "/v1/admin/users/{id}", tag: A, summary: "Change a user's name, role or status", description: "Changing the role or disabling ends the user's sessions.", auth: "admin", body: ConsoleUserPatch, response: { status: 200, schema: ConsoleUser } },
    async (c, { body }) => {
      const u = await manageable(c);
      if (body.role && !canManageRole(c.get("actor").role, body.role)) throw forbidden("only owners can grant the owner role");
      const updated = await updateUser(sql, c.get("tenantId"), u.id, { ...body, ...(body.role === u.role ? { role: undefined } : {}) });
      return c.json(toConsoleUser(updated!));
    });

  route(app, { method: "delete", path: "/v1/admin/users/{id}", tag: A, summary: "Remove a console user", auth: "admin", response: { status: 204 } },
    async (c) => {
      const u = await manageable(c);
      await deleteUser(sql, c.get("tenantId"), u.id);
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ SSO settings
  route(app, { method: "get", path: "/v1/admin/sso", tag: A, summary: "Single sign-on settings", auth: "admin", response: { status: 200, schema: SsoConfig } },
    async (c) => c.json(toSsoConfig(await getSso(sql, c.get("tenantId")), cfg.PUBLIC_BASE_URL)));

  route(app, {
      method: "put", path: "/v1/admin/sso", tag: A, summary: "Configure single sign-on (OpenID Connect)",
      description: "The issuer's discovery document is checked before saving. Register `redirectUri` with your identity provider.",
      auth: "admin", body: SsoConfigInput, response: { status: 200, schema: SsoConfig },
    },
    async (c, { body }) => {
      const tenantId = c.get("tenantId");
      try {
        await discover(body.issuer, allowPrivate, true);
      } catch (err) {
        throw badRequest(`cannot use this issuer: ${err instanceof OidcError ? err.message : (err as Error).message}`);
      }
      const row = await putSso(sql, s.secretsKey, tenantId, { ...body, issuer: body.issuer.replace(/\/+$/, "") });
      return c.json(toSsoConfig(row, cfg.PUBLIC_BASE_URL));
    });

  route(app, { method: "delete", path: "/v1/admin/sso", tag: A, summary: "Remove single sign-on", description: "Console users can no longer sign in; API keys keep working.", auth: "admin", response: { status: 204 } },
    async (c) => {
      await sql`DELETE FROM sso_configs WHERE tenant_id = ${c.get("tenantId")}`;
      await sql`DELETE FROM console_sessions WHERE user_id IN (SELECT id FROM console_users WHERE tenant_id = ${c.get("tenantId")})`;
      return c.body(null, 204);
    });
}
