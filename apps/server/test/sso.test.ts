/** Console users, roles and OpenID Connect sign-in against a mock identity provider. */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { clearOidcCaches } from "../src/auth/oidc.js";
import { routePermission } from "../src/auth/permissions.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import { createServices } from "../src/services.js";

const DB = process.env.TEST_DATABASE_URL;

describe("permissions", () => {
  it("maps routes to permissions, closed by default", () => {
    expect(routePermission("GET", "/v1/admin/assistants")).toBe("config:read");
    expect(routePermission("PATCH", "/v1/admin/assistants/{id}")).toBe("config:write");
    expect(routePermission("PUT", "/v1/admin/sources/{id}/documents")).toBe("knowledge:write");
    expect(routePermission("POST", "/v1/admin/sources/{id}/files")).toBe("knowledge:write");
    expect(routePermission("GET", "/v1/admin/conversations/export")).toBe("conversations:export");
    expect(routePermission("DELETE", "/v1/admin/conversations/{id}")).toBe("conversations:delete");
    expect(routePermission("DELETE", "/v1/admin/subjects/{subjectId}")).toBe("conversations:delete");
    expect(routePermission("GET", "/v1/admin/keys")).toBe("security:manage");
    expect(routePermission("GET", "/v1/admin/audit-log")).toBe("security:manage");
    expect(routePermission("GET", "/v1/admin/insights")).toBe("analytics:read");
    expect(routePermission("GET", "/v1/admin/me")).toBeNull();
    expect(routePermission("POST", "/v1/admin/something-new")).toBe("config:write");
  });
});

describe.skipIf(!DB)("console sign-in (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let idp: Server;
  let issuer: string;
  let adminKey: string;
  let tenantId: string;
  let privateKey: CryptoKey;
  let nextToken: (claims: Record<string, unknown>) => Record<string, unknown> = (c) => c;
  const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown> }>();

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await app.request(`/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const admin = (method: string, path: string, body?: unknown) => call(adminKey, method, path, body);

  /** Run the browser side of a sign-in; returns the console fragment parameters. */
  async function signIn(claims: Record<string, unknown>, tamper?: { state?: string }) {
    const start = await app.request("/auth/oidc/start");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    if (!loc.href.startsWith(issuer)) return Object.fromEntries(new URLSearchParams(loc.hash.split("?")[1]));
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    expect(start.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/oidc/callback");
    const code = `code-${codes.size}`;
    codes.set(code, { nonce: loc.searchParams.get("nonce")!, challenge: loc.searchParams.get("code_challenge")!, claims });
    const state = tamper?.state ?? loc.searchParams.get("state")!;
    const cb = await app.request(`/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.pathname).toBe("/admin/");
    return Object.fromEntries(new URLSearchParams(back.hash.split("?")[1]));
  }

  async function session(claims: Record<string, unknown>): Promise<string> {
    const r = await signIn(claims);
    expect(r.error, r.error).toBeUndefined();
    const res = await app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: r.code }) });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.token).toMatch(/^ea_cs_/);
    // A code works once.
    const again = await app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: r.code }) });
    expect(again.status).toBe(401);
    return j.token;
  }

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    idp = createServer((rq, rs) => {
      const json = (status: number, body: unknown) => rs.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(rq.url!, issuer);
      if (url.pathname === "/.well-known/openid-configuration") {
        return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_basic"] });
      }
      if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
      if (url.pathname === "/token" && rq.method === "POST") {
        let raw = "";
        rq.on("data", (d) => (raw += d));
        rq.on("end", async () => {
          const form = new URLSearchParams(raw);
          if (rq.headers.authorization !== `Basic ${Buffer.from("console-app:s3cret").toString("base64")}`) return json(401, { error: "invalid_client" });
          const entry = codes.get(form.get("code") ?? "");
          if (!entry || form.get("grant_type") !== "authorization_code") return json(400, { error: "invalid_grant" });
          codes.delete(form.get("code")!);
          if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
          const claims = nextToken({ nonce: entry.nonce, ...entry.claims });
          const idToken = await new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(issuer)
            .setAudience("console-app")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          json(200, { access_token: "at", token_type: "Bearer", id_token: idToken });
        });
        return;
      }
      rs.writeHead(404).end();
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({
      SECRET_KEY: "test-secret-key-0123456789abcdefghijkl",
      DATABASE_URL: DB,
      LOG_LEVEL: "silent",
      SERVE_WIDGET: "false",
      SERVE_CONSOLE: "false",
      OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true",
    });
    const models = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } });
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    app = createApp(s);
    tenantId = await createTenant(sql, "Acme");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "bootstrap", k.hash, k.prefix);
    adminKey = k.key;
    clearOidcCaches();
  });

  afterAll(async () => {
    idp?.close();
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("configures SSO after checking the issuer", async () => {
    expect((await app.request("/auth/sso").then((r) => r.json()))).toEqual({ enabled: false, tenantRequired: false });
    expect((await signIn({})).error).toMatch(/not set up/);
    const bad = await admin("PUT", "/sso", { issuer: `${issuer}/nope`, clientId: "console-app", clientSecret: "s3cret" });
    expect(bad.status).toBe(400);
    const ok = await admin("PUT", "/sso", { issuer, clientId: "console-app", clientSecret: "s3cret" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, issuer, clientId: "console-app", hasClientSecret: true, autoProvisionRole: null, redirectUri: "http://localhost:8787/auth/oidc/callback" });
    expect(JSON.stringify(ok.body)).not.toContain("s3cret");
    // Updating without a secret keeps it.
    expect((await admin("PUT", "/sso", { issuer, clientId: "console-app" })).body.hasClientSecret).toBe(true);
    expect((await app.request("/auth/sso").then((r) => r.json()))).toEqual({ enabled: true, tenantRequired: false });
  });

  it("only lets invited people in, by verified e-mail", async () => {
    expect((await signIn({ sub: "u1", email: "ed@acme.test", email_verified: true })).error).toMatch(/not been invited/);
    const invited = await admin("POST", "/users", { email: "Ed@Acme.test", name: "Ed", role: "editor" });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ email: "ed@acme.test", role: "editor", lastLoginAt: null });
    expect((await admin("POST", "/users", { email: "ed@acme.test", role: "analyst" })).status).toBe(409);
    expect((await signIn({ sub: "u1", email: "ed@acme.test", email_verified: false })).error).toMatch(/verified e-mail/);
    const log = await admin("GET", "/audit-log?action=auth");
    expect(log.body.items.map((e: { action: string }) => e.action)).toEqual(["auth.login-denied", "auth.login-denied"]);
  });

  it("enforces the role on every admin route", async () => {
    const token = await session({ sub: "u1", email: "ed@acme.test", email_verified: true, name: "Edith" });
    const me = await call(token, "GET", "/me");
    expect(me.body).toMatchObject({ type: "user", email: "ed@acme.test", name: "Ed", role: "editor", tenantId });
    expect(me.body.permissions).toContain("knowledge:write");
    expect(me.body.permissions).not.toContain("config:write");

    expect((await call(token, "GET", "/assistants")).status).toBe(200);
    const denied = await call(token, "POST", "/assistants", { name: "x" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/editor.*config:write/);
    expect((await call(token, "GET", "/keys")).status).toBe(403);
    expect((await call(token, "GET", "/audit-log")).status).toBe(403);
    expect((await call(token, "DELETE", "/subjects/user-1")).status).toBe(403);

    const src = await admin("POST", "/sources", { name: "Docs", type: "manual" });
    const doc = await call(token, "PUT", `/sources/${src.body.id}/documents`, { externalId: "a", title: "A", content: "Hello" });
    expect(doc.status, JSON.stringify(doc.body)).toBe(200);
    const entry = (await admin("GET", "/audit-log?action=documents.upsert")).body.items[0];
    expect(entry.actor).toMatchObject({ type: "user", name: "ed@acme.test" });

    // Subsequent sign-ins match the subject, even if the e-mail changes.
    const again = await session({ sub: "u1", email: "edith@acme.test", email_verified: true });
    expect((await call(again, "GET", "/me")).body.email).toBe("ed@acme.test");

    // A role change ends existing sessions.
    const users = (await admin("GET", "/users")).body;
    const ed = users.find((u: { email: string }) => u.email === "ed@acme.test");
    expect(ed.lastLoginAt).not.toBeNull();
    expect((await admin("PATCH", `/users/${ed.id}`, { role: "agent" })).body.role).toBe("agent");
    expect((await call(token, "GET", "/me")).status).toBe(401);
    expect((await call(again, "GET", "/me")).status).toBe(401);
  });

  it("auto-provisions allowed domains and limits admins", async () => {
    await admin("PUT", "/sso", { issuer, clientId: "console-app", autoProvisionRole: "analyst", allowedDomains: ["acme.test"] });
    expect((await signIn({ sub: "x1", email: "eve@evil.test", email_verified: true })).error).toMatch(/not allowed for evil.test/);
    const analyst = await session({ sub: "a1", email: "ann@acme.test", email_verified: true });
    expect((await call(analyst, "GET", "/me")).body.role).toBe("analyst");
    const exp = await app.request("/v1/admin/conversations/export", { headers: { authorization: `Bearer ${analyst}` } });
    expect(exp.status).toBe(200);
    await exp.text();
    expect((await call(analyst, "DELETE", "/conversations/conv_x")).status).toBe(403);

    // Admins manage everyone but owners, and never themselves.
    await admin("POST", "/users", { email: "boss@acme.test", role: "owner" });
    await admin("POST", "/users", { email: "adm@acme.test", role: "admin" });
    const adm = await session({ sub: "ad1", email: "adm@acme.test", email_verified: true });
    expect((await call(adm, "POST", "/users", { email: "new@acme.test", role: "owner" })).status).toBe(403);
    expect((await call(adm, "POST", "/users", { email: "new@acme.test", role: "editor" })).status).toBe(201);
    const users = (await call(adm, "GET", "/users")).body as { id: string; email: string }[];
    const id = (e: string) => users.find((u) => u.email === e)!.id;
    expect((await call(adm, "PATCH", `/users/${id("boss@acme.test")}`, { disabled: true })).status).toBe(403);
    expect((await call(adm, "PATCH", `/users/${id("adm@acme.test")}`, { role: "owner" })).status).toBe(400);
    expect((await call(adm, "PATCH", `/users/${id("ann@acme.test")}`, { disabled: true })).body.disabled).toBe(true);
    expect((await call(analyst, "GET", "/me")).status).toBe(401);
    expect((await signIn({ sub: "a1", email: "ann@acme.test", email_verified: true })).error).toMatch(/disabled/);
    expect((await call(adm, "DELETE", `/users/${id("new@acme.test")}`)).status).toBe(204);

    const out = await call(adm, "POST", "/logout");
    expect(out.status).toBe(204);
    expect((await call(adm, "GET", "/me")).status).toBe(401);
  });

  it("rejects tampered sign-ins", async () => {
    expect((await signIn({ sub: "ad1", email: "adm@acme.test" }, { state: "forged" })).error).toMatch(/state mismatch/);
    nextToken = (c) => ({ ...c, nonce: "replayed" });
    expect((await signIn({ sub: "ad1", email: "adm@acme.test" })).error).toMatch(/nonce/);
    nextToken = (c) => c;
    const noCookie = await app.request("/auth/oidc/callback?code=x&state=y");
    expect(new URL(noCookie.headers.get("location")!).hash).toMatch(/error=/);
    // Removing SSO ends console sessions; API keys keep working.
    const t = await session({ sub: "ad1", email: "adm@acme.test" });
    expect((await admin("DELETE", "/sso")).status).toBe(204);
    expect((await call(t, "GET", "/me")).status).toBe(401);
    expect((await admin("GET", "/me")).body).toMatchObject({ type: "api_key", role: "owner" });
  });
});
