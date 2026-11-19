/**
 * End-to-end API tests against a real Postgres with pgvector.
 * Set TEST_DATABASE_URL (the schema is dropped and recreated). Skipped otherwise.
 */
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { createServices } from "../src/services.js";

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://shop.example";

/** Streams slowly until aborted; reports token usage. */
class SlowModel implements ChatModel {
  readonly id = "slow";
  readonly provider = "test";
  readonly model = "slow";
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    for (let i = 0; i < 40; i++) {
      if (req.signal.aborted) throw req.signal.reason;
      yield { type: "text", text: `part${i} ` };
      await new Promise((r) => setTimeout(r, 25));
    }
    yield { type: "usage", inputTokens: 100, outputTokens: 50 };
  }
}

describe.skipIf(!DB)("API (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let widgetId: string;
  let identitySecret: string;
  let assistantId: string;

  const req = (method: string, path: string, opts: { token?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, { token: adminKey, body, origin: null });
  const json = async (res: Response | Promise<Response>, status?: number) => {
    const r = await res;
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const session = async (body: Record<string, unknown> = {}) =>
    (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId: "anon-test-abcdefghijklmnopq", ...body } }), 201)).token as string;
  const events = async (token: string, runId: string, lastEventId?: number) => {
    const res = await req("GET", `/v1/runs/${runId}/events`, { token, headers: lastEventId ? { "last-event-id": String(lastEventId) } : {} });
    expect(res.status).toBe(200);
    const text = await res.text();
    return text
      .split("\n\n")
      .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(6)) as { seq: number; type: string; data: Record<string, any> });
  };
  const ask = async (token: string, conv: string, content: string, extra: Record<string, unknown> = {}) =>
    json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content, ...extra } }));

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } });
    models.register(new SlowModel(), ["slow"]);
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    await s.bus.listen();
    app = createApp(s);

    const tenantId = await createTenant(sql, "Test");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "test", k.hash, k.prefix);
    adminKey = k.key;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(5000);
    await sql.end({ timeout: 5 });
  });

  it("rejects missing or wrong admin keys", async () => {
    expect((await app.request("/v1/admin/assistants")).status).toBe(401);
    expect((await req("GET", "/v1/admin/assistants", { token: "ea_admin_nope" })).status).toBe(401);
  });

  it("sets up knowledge, an assistant and a widget through the admin API", async () => {
    const pub = await json(admin("POST", "/sources", { name: "Public docs", type: "manual" }), 201);
    const priv = await json(admin("POST", "/sources", { name: "Staff runbooks", type: "manual", access: ["staff"] }), 201);
    await json(admin("PUT", `/sources/${pub.id}/documents`, { title: "Refund policy", content: "# Refunds\n\nRefunds are possible within 30 days of purchase." }), 200);
    const again = await json(admin("PUT", `/sources/${pub.id}/documents`, { title: "Refund policy", content: "# Refunds\n\nRefunds are possible within 30 days of purchase." }), 200);
    expect(again.changed).toBe(false);
    await json(admin("PUT", `/sources/${priv.id}/documents`, { title: "Zebracorn escalation", content: "Escalate zebracorn incidents to the on-call lead." }), 200);

    await json(admin("POST", "/assistants", { name: "Help", modelAlias: "nope" }), 400);
    const a = await json(admin("POST", "/assistants", { name: "Help", instructions: "Be brief.", sourceIds: [pub.id, priv.id] }), 201);
    assistantId = a.id;
    const patched = await json(admin("PATCH", `/assistants/${a.id}`, { name: "Help center" }), 200);
    expect(patched).toMatchObject({ name: "Help center", instructions: "Be brief.", version: 2 });
    expect(patched.sourceIds).toHaveLength(2);

    const w = await json(admin("POST", "/widgets", { assistantId: a.id, name: "Shop", allowedOrigins: [ORIGIN] }), 201);
    widgetId = w.widget.id;
    identitySecret = w.identitySecret;
    expect(w.embedSnippet).toContain(widgetId);
  });

  it("enforces the widget origin allowlist", async () => {
    expect((await req("GET", `/v1/widgets/${widgetId}/config`, { origin: "https://evil.example" })).status).toBe(403);
    const cfg = await json(req("GET", `/v1/widgets/${widgetId}/config`), 200);
    expect(cfg.assistant.name).toBe("Help center");
    expect((await req("POST", "/v1/sessions", { body: { widgetId }, origin: "https://evil.example" })).status).toBe(403);
    const pre = await req("OPTIONS", "/v1/sessions", { headers: { "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("answers with citations and streams resumable events", async () => {
    const token = await session();
    const conv = await json(req("POST", "/v1/conversations", { token, body: {} }), 201);
    const created = await ask(token, conv.id, "Can I get a refund?");
    expect(created.run.status).toBe("queued");
    const evs = await events(token, created.run.id);
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(["run.started", "retrieval.completed", "message.started", "message.delta", "message.completed", "run.completed"]));
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    const done = evs.find((e) => e.type === "message.completed")!.data.message;
    expect(done.content).toContain("30 days");
    expect(done.citations[0].title).toContain("Refund");

    const resumed = await events(token, created.run.id, 3);
    expect(resumed[0]!.seq).toBe(4);

    const msgs = await json(req("GET", `/v1/conversations/${conv.id}/messages`, { token }), 200);
    expect(msgs.items.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    const list = await json(req("GET", "/v1/conversations", { token }), 200);
    expect(list.items[0].title).toBe("Can I get a refund?");

    await json(req("POST", `/v1/messages/${done.id}/feedback`, { token, body: { rating: "up" } }), 204);
  });

  it("returns the same run for a repeated idempotency key", async () => {
    const token = await session();
    const conv = await json(req("POST", "/v1/conversations", { token, body: {} }), 201);
    const a = await ask(token, conv.id, "refund?", { idempotencyKey: "idem-key-0001" });
    await events(token, a.run.id);
    const b = await ask(token, conv.id, "refund?", { idempotencyKey: "idem-key-0001" });
    expect(b.run.id).toBe(a.run.id);
    const msgs = await json(req("GET", `/v1/conversations/${conv.id}/messages`, { token }), 200);
    expect(msgs.items).toHaveLength(2);
  });

  it("isolates conversations between visitors", async () => {
    const mine = await session();
    const conv = await json(req("POST", "/v1/conversations", { token: mine, body: {} }), 201);
    const other = await session({ anonymousId: "someone-else-abcdefghijklmn" });
    expect((await req("GET", `/v1/conversations/${conv.id}`, { token: other })).status).toBe(404);
    expect((await req("POST", `/v1/conversations/${conv.id}/runs`, { token: other, body: { content: "hi" } })).status).toBe(404);
    const list = await json(req("GET", "/v1/conversations", { token: other }), 200);
    expect(list.items.find((c: { id: string }) => c.id === conv.id)).toBeUndefined();
  });

  it("filters knowledge by access group before the model sees it", async () => {
    const anon = await session();
    const c1 = await json(req("POST", "/v1/conversations", { token: anon, body: {} }), 201);
    const r1 = await ask(anon, c1.id, "zebracorn escalation");
    const e1 = await events(anon, r1.run.id);
    expect(e1.find((e) => e.type === "retrieval.completed")!.data.sources).toHaveLength(0);

    const now = Math.floor(Date.now() / 1000);
    const userToken = await new SignJWT({ sub: "u-42", exp: now + 600, groups: ["staff"], name: "Ada" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(identitySecret));
    const staff = await session({ userToken });
    const c2 = await json(req("POST", "/v1/conversations", { token: staff, body: {} }), 201);
    const r2 = await ask(staff, c2.id, "zebracorn escalation");
    const e2 = await events(staff, r2.run.id);
    expect(e2.find((e) => e.type === "retrieval.completed")!.data.sources[0].title).toContain("Zebracorn");

    const forged = await new SignJWT({ sub: "u-42", exp: now + 600, groups: ["staff"] }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("not-the-secret-xxxxxxxxxxxx"));
    expect((await req("POST", "/v1/sessions", { body: { widgetId, userToken: forged } })).status).toBe(401);
  });

  it("allows one active run per conversation, cancels, and enforces the token budget", async () => {
    await json(admin("PATCH", `/assistants/${assistantId}`, { modelAlias: "slow" }), 200);
    const token = await session({ anonymousId: "cancel-test-abcdefghijklmnop" });
    const conv = await json(req("POST", "/v1/conversations", { token, body: {} }), 201);
    const run = await ask(token, conv.id, "tell me a long story");
    const busy = await req("POST", `/v1/conversations/${conv.id}/runs`, { token, body: { content: "again" } });
    expect(busy.status).toBe(409);

    await new Promise((r) => setTimeout(r, 150));
    await json(req("POST", `/v1/runs/${run.run.id}/cancel`, { token }), 202);
    const evs = await events(token, run.run.id);
    expect(evs.at(-1)!.type).toBe("run.cancelled");
    const msgs = await json(req("GET", `/v1/conversations/${conv.id}/messages`, { token }), 200);
    expect(msgs.items.at(-1).status).toBe("cancelled");

    const full = await ask(token, conv.id, "short one");
    const fe = await events(token, full.run.id);
    expect(fe.at(-1)!.type).toBe("run.completed");
    expect(fe.at(-1)!.data.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    await json(admin("PATCH", `/widgets/${widgetId}`, { dailyTokenBudget: 100 }), 200);
    const over = await req("POST", `/v1/conversations/${conv.id}/runs`, { token, body: { content: "one more" } });
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe("budget_exceeded");
    expect(over.headers.get("retry-after")).toBeTruthy();
    await json(admin("PATCH", `/widgets/${widgetId}`, { dailyTokenBudget: null }), 200);
    await json(admin("PATCH", `/assistants/${assistantId}`, { modelAlias: "standard" }), 200);
  });

  it("rejects oversized bodies and non-http URLs", async () => {
    const token = await session();
    const conv = await json(req("POST", "/v1/conversations", { token, body: {} }), 201);
    const big = await req("POST", `/v1/conversations/${conv.id}/runs`, { token, body: { content: "x".repeat(100_000) } });
    expect(big.status).toBe(413);
    const src = (await json(admin("GET", "/sources"), 200))[0];
    await json(admin("PUT", `/sources/${src.id}/documents`, { title: "x", content: "y", url: "javascript:alert(1)" }), 400);
    await json(admin("POST", "/sources", { name: "bad", type: "url", url: "file:///etc/passwd" }), 400);
  });

  it("serves health, metrics and an OpenAPI document", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect(await (await app.request("/metrics")).text()).toContain("ea_runs_total");
    const doc = await json(app.request("/openapi.json"), 200);
    expect(doc.paths["/v1/conversations/{id}/runs"].post.requestBody).toBeTruthy();
    const usage = await json(admin("GET", "/usage"), 200);
    expect(usage.runs).toBeGreaterThan(3);
    expect(usage.feedbackUp).toBe(1);
  });
});
