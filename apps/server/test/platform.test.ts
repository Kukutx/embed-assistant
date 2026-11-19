/** Platform API (tenant lifecycle) and SECRET_KEY rotation. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { createLogger } from "../src/lib/log.js";
import { decrypt, deriveKey, encrypt, isCurrent, keyring } from "../src/lib/crypto.js";
import { ModelRegistry } from "../src/models/registry.js";
import { rotateSecrets } from "../src/ops/rotateSecrets.js";
import { createServices } from "../src/services.js";

const OLD = "old-secret-key-0123456789abcdefghijklmnop";
const NEW = "new-secret-key-0123456789abcdefghijklmnop";
const PLATFORM = "platform-token-0123456789abcdefghijklmnop";
const ORIGIN = "https://shop.example";

describe("key rings", () => {
  it("decrypts with previous keys and encrypts with the current one", () => {
    const a = deriveKey(OLD, "x");
    const b = deriveKey(NEW, "x");
    const old = encrypt(a, "secret value");
    expect(() => decrypt(b, old)).toThrow();
    const ring = keyring(b, [a]);
    expect(decrypt(ring, old)).toBe("secret value");
    expect(isCurrent(ring, old)).toBe(false);
    const fresh = encrypt(ring, "secret value");
    expect(isCurrent(ring, fresh)).toBe(true);
    expect(() => decrypt(a, fresh)).toThrow();
    // Still a plain Buffer for everything else.
    expect(Buffer.isBuffer(ring)).toBe(true);
    expect(ring.equals(b)).toBe(true);
  });
});

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("platform API and secret rotation (postgres)", () => {
  let sql: Sql;
  const made: Services[] = [];
  const build = (env: Record<string, string>) => {
    const cfg = loadConfig({ SECRET_KEY: OLD, DATABASE_URL: DB, LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false", ...env });
    const s = createServices(cfg, { sql, log: createLogger("silent"), models: new ModelRegistry({ deployments: [], aliases: { standard: [] } }) });
    made.push(s);
    const app = createApp(s);
    const call = async (method: string, path: string, opts: { token?: string; body?: unknown; status?: number } = {}) => {
      const res = await app.request(path, {
        method,
        headers: {
          origin: ORIGIN,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      if (opts.status !== undefined) expect(res.status, text).toBe(opts.status);
      return text ? JSON.parse(text) : null;
    };
    return { s, call };
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const s of made) await s.executor.shutdown(500);
    await sql.end({ timeout: 5 });
  });

  it("does not exist without PLATFORM_ADMIN_TOKEN", async () => {
    const { call } = build({});
    await call("GET", "/v1/platform/tenants", { token: PLATFORM, status: 404 });
  });

  it("creates, lists, suspends, reactivates and deletes tenants", async () => {
    const { call } = build({ PLATFORM_ADMIN_TOKEN: PLATFORM });
    const p = (method: string, path: string, body?: unknown, status?: number) => call(method, `/v1/platform${path}`, { token: PLATFORM, body, status });
    await call("GET", "/v1/platform/tenants", { token: "wrong-token-0123456789abcdefghijklmnop", status: 401 });

    const acme = await p("POST", "/tenants", { name: "Acme", externalId: "cus_123", metadata: { plan: "enterprise", region: "eu" } }, 201);
    expect(acme.tenant).toMatchObject({ name: "Acme", externalId: "cus_123", status: "active", metadata: { plan: "enterprise" }, usage: { conversations: 0 } });
    expect(acme.adminKey).toMatch(/^ea_admin_/);
    await p("POST", "/tenants", { name: "Acme again", externalId: "cus_123" }, 409);
    await p("POST", "/tenants", { name: "Beta" }, 201);
    await p("POST", "/tenants", { name: "Gamma" }, 201);

    const page1 = await p("GET", "/tenants?limit=2");
    expect(page1.items.map((t: { name: string }) => t.name)).toEqual(["Acme", "Beta"]);
    const page2 = await p("GET", `/tenants?limit=2&cursor=${page1.nextCursor}`);
    expect(page2).toMatchObject({ items: [{ name: "Gamma" }], nextCursor: null });
    expect((await p("GET", "/tenants?externalId=cus_123")).items).toHaveLength(1);
    expect((await p("GET", "/tenants?q=amm")).items.map((t: { name: string }) => t.name)).toEqual(["Gamma"]);

    // The tenant works: its key configures a widget, visitors get sessions.
    const admin = (method: string, path: string, body?: unknown, status?: number) => call(method, `/v1/admin${path}`, { token: acme.adminKey, body, status });
    const a = await admin("POST", "/assistants", { name: "Help" }, 201);
    const w = (await admin("POST", "/widgets", { assistantId: a.id, name: "Site", allowedOrigins: [ORIGIN] }, 201)).widget;
    const session = () => call("POST", "/v1/sessions", { body: { widgetId: w.id, anonymousId: "platform-test-abcdefghijklmnop" } });
    expect((await session()).token).toBeTruthy();

    const suspended = await p("PATCH", `/tenants/${acme.tenant.id}`, { status: "suspended" }, 200);
    expect(suspended).toMatchObject({ status: "suspended", suspendedAt: expect.any(String) });
    expect((await admin("GET", "/me", undefined, 403)).error.message).toMatch(/suspended/);
    await new Promise((ok) => setTimeout(ok, 5100)); // widget cache TTL
    expect((await session()).error.code).toBe("not_found");
    await call("GET", `/v1/widgets/${w.id}/config`, { status: 404 });

    const back = await p("PATCH", `/tenants/${acme.tenant.id}`, { status: "active", name: "Acme Corp" }, 200);
    // An active tenant cannot be deleted in one call.
    await p("DELETE", `/tenants/${acme.tenant.id}`, undefined, 409);
    expect(back).toMatchObject({ status: "active", suspendedAt: null, name: "Acme Corp" });
    expect((await admin("GET", "/me", undefined, 200)).tenantId).toBe(acme.tenant.id);
    const audit = await admin("GET", "/audit-log");
    expect(audit.items.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["tenant.create", "tenant.suspend", "tenant.reactivate"]));
    expect(audit.items.find((e: { action: string }) => e.action === "tenant.suspend").actor).toMatchObject({ type: "system", name: "platform operator" });

    // Recovery key.
    const k = await p("POST", `/tenants/${acme.tenant.id}/keys`, { name: "support" }, 201);
    expect((await call("GET", "/v1/admin/me", { token: k.key, status: 200 })).name).toBe("support");

    // Delete: suspend first, then everything owned by the tenant is gone.
    await admin("POST", "/webhooks", { url: "https://hooks.example/x", events: ["audit.recorded"] }, 201);
    await p("PATCH", `/tenants/${acme.tenant.id}`, { status: "suspended" }, 200);
    await p("DELETE", `/tenants/${acme.tenant.id}`, undefined, 204);
    await p("GET", `/tenants/${acme.tenant.id}`, undefined, 404);
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`;
    for (const { table_name } of tables) {
      const [{ n }] = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${table_name}" WHERE tenant_id = $1`, [acme.tenant.id])) as unknown as [{ n: number }];
      expect(n, table_name).toBe(0);
    }
    expect((await p("GET", "/tenants")).items.map((t: { name: string }) => t.name)).toEqual(["Beta", "Gamma"]);
  }, 20_000);

  it("rotates SECRET_KEY without breaking sessions, widgets, actions or webhooks", async () => {
    const before = build({ PLATFORM_ADMIN_TOKEN: PLATFORM });
    const t = await before.call("POST", "/v1/platform/tenants", { token: PLATFORM, body: { name: "Rotate" }, status: 201 });
    const admin = (c: typeof before.call, method: string, path: string, body?: unknown, status?: number) => c(method, `/v1/admin${path}`, { token: t.adminKey, body, status });
    const a = await admin(before.call, "POST", "/assistants", { name: "Help" }, 201);
    const created = await admin(before.call, "POST", "/widgets", { assistantId: a.id, name: "Site", allowedOrigins: [ORIGIN] }, 201);
    await admin(before.call, "POST", "/actions", {
      name: "lookup", title: "Lookup", description: "Look something up", method: "GET", url: "https://api.example/x",
      headers: { authorization: "Bearer upstream-secret" }, parameters: { type: "object", properties: {} },
    }, 201);
    await admin(before.call, "POST", "/webhooks", { url: "https://hooks.example/y", events: ["message.completed"] }, 201);
    const oldSession = (await before.call("POST", "/v1/sessions", { body: { widgetId: created.widget.id, anonymousId: "rotate-test-abcdefghijklmnop" }, status: 201 })).token;

    // Deploy with the new key, the old one kept as previous.
    const during = build({ SECRET_KEY: NEW, SECRET_KEY_PREVIOUS: `${OLD}` });
    await during.call("GET", `/v1/conversations`, { token: oldSession, status: 200 });
    const userToken = await new SignJWT({ name: "Ana" }).setProtectedHeader({ alg: "HS256" }).setSubject("u1").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(created.identitySecret));
    const signedIn = await during.call("POST", "/v1/sessions", { body: { widgetId: created.widget.id, userToken }, status: 201 });
    expect(signedIn.subject).toMatchObject({ kind: "user", name: "Ana" });

    const dry = await rotateSecrets(sql, during.s.secretsKey, { dryRun: true });
    expect(dry.find((r) => r.table === "widgets")!.rotated).toBeGreaterThanOrEqual(1);
    const report = await rotateSecrets(sql, during.s.secretsKey);
    expect(report.map((r) => [r.table, r.rotated > 0, r.unreadable])).toEqual([
      ["widgets", true, 0], ["actions", true, 0], ["webhooks", true, 0], ["mcp_servers", false, 0], ["sso_configs", false, 0],
    ]);
    expect((await rotateSecrets(sql, during.s.secretsKey)).every((r) => r.rotated === 0)).toBe(true);

    // The old key can go: everything still decrypts, old sessions are refused.
    const after = build({ SECRET_KEY: NEW });
    await after.call("GET", `/v1/conversations`, { token: oldSession, status: 401 });
    await after.call("POST", "/v1/sessions", { body: { widgetId: created.widget.id, userToken }, status: 201 });
    const [hook] = await sql<{ secret: string }[]>`SELECT secret FROM webhooks WHERE tenant_id = ${t.tenant.id}`;
    expect(decrypt(after.s.secretsKey, hook!.secret)).toMatch(/^whsec_/);
    const [action] = await sql<{ headers: string }[]>`SELECT headers FROM actions WHERE tenant_id = ${t.tenant.id}`;
    expect(JSON.parse(decrypt(after.s.secretsKey, action!.headers))).toEqual({ authorization: "Bearer upstream-secret" });
  });
});
