/** Audit log: every successful admin change is recorded once, with secrets redacted. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { auditAction, purgeAudit, redactForAudit } from "../src/lib/audit.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import { createServices } from "../src/services.js";

const DB = process.env.TEST_DATABASE_URL;

describe("audit naming and redaction", () => {
  it("derives action names from routes", () => {
    const a = (m: string, p: string) => auditAction(m, p);
    expect(a("PATCH", "/v1/admin/widgets/:id")).toEqual({ action: "widgets.update", targetType: "widgets", targetParam: "id" });
    expect(a("POST", "/v1/admin/widgets")).toEqual({ action: "widgets.create", targetType: "widgets", targetParam: null });
    expect(a("POST", "/v1/admin/widgets/:id/rotate-secret")).toEqual({ action: "widgets.rotate-secret", targetType: "widgets", targetParam: "id" });
    expect(a("PUT", "/v1/admin/sources/:id/documents")?.action).toBe("documents.upsert");
    expect(a("DELETE", "/v1/admin/sources/:id/documents/:docId")).toEqual({ action: "documents.delete", targetType: "documents", targetParam: "docId" });
    expect(a("POST", "/v1/admin/sources/:id/files")?.action).toBe("documents.upload");
    expect(a("DELETE", "/v1/admin/keys/:id")?.action).toBe("keys.revoke");
    expect(a("DELETE", "/v1/admin/subjects/:subjectId")).toEqual({ action: "subjects.erase", targetType: "subjects", targetParam: "subjectId" });
    expect(a("PATCH", "/v1/admin/settings")).toEqual({ action: "settings.update", targetType: "settings", targetParam: null });
    expect(a("GET", "/v1/admin/conversations/export")?.action).toBe("conversations.export");
    expect(a("GET", "/v1/admin/widgets/:id")).toBeNull();
    expect(a("POST", "/v1/sessions")).toBeNull();
  });

  it("redacts secrets and shortens long values", () => {
    const out = redactForAudit({
      name: "orders",
      headers: { "X-Api": "abc", Authorization: "Bearer x" },
      identitySecret: "s",
      nested: { apiKey: "k", password: "", ok: 1 },
      content: "x".repeat(2000),
      list: Array.from({ length: 60 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(out.headers).toEqual({ "X-Api": "[redacted]", Authorization: "[redacted]" });
    expect(out.identitySecret).toBe("[redacted]");
    expect(out.nested).toEqual({ apiKey: "[redacted]", password: "", ok: 1 });
    expect(out.content).toMatch(/^x{500}… \(2000 chars\)$/);
    expect((out.list as unknown[]).length).toBe(51);
  });
});

describe.skipIf(!DB)("audit log (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let keyId: string;
  let tenantId: string;

  const admin = async (method: string, path: string, body?: unknown, status?: number) => {
    const r = await app.request(`/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, "user-agent": "audit-test", "x-request-id": "req-audit-1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } });
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    app = createApp(s);
    tenantId = await createTenant(sql, "Audit");
    const k = generateAdminKey();
    keyId = await insertAdminKey(sql, tenantId, "ci-bot", k.hash, k.prefix);
    adminKey = k.key;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("records changes with actor, target and redacted body", async () => {
    await admin("POST", "/webhooks", { url: "https://siem.example/hook", events: ["audit.recorded"] }, 201);
    const a = await admin("POST", "/assistants", { name: "Help" }, 201);
    await admin("PATCH", `/assistants/${a.id}`, { instructions: "Be brief." }, 200);
    const w = await admin("POST", "/widgets", { assistantId: a.id, name: "Site" }, 201);
    await admin("POST", `/widgets/${w.widget.id}/rotate-secret`, undefined, 200);
    await admin("POST", "/actions", { name: "order", title: "Order", description: "Look up an order", url: "https://shop.example/o", headers: { Authorization: "Bearer top-secret" } }, 201);
    // Reads and failures are not recorded.
    await admin("GET", "/assistants", undefined, 200);
    await admin("PATCH", "/assistants/ast_missing", { name: "x" }, 404);
    await admin("POST", "/assistants", { name: "" }, 400);

    const log = await admin("GET", "/audit-log", undefined, 200);
    expect(log.items.map((e: { action: string }) => e.action)).toEqual([
      "actions.create",
      "widgets.rotate-secret",
      "widgets.create",
      "assistants.update",
      "assistants.create",
      "webhooks.create",
    ]);
    const [action, rotate, , update, create] = log.items;
    expect(update).toMatchObject({
      actor: { type: "api_key", id: keyId, name: "ci-bot" },
      method: "PATCH",
      route: "/v1/admin/assistants/{id}",
      target: { type: "assistants", id: a.id },
      status: 200,
      userAgent: "audit-test",
      requestId: "req-audit-1",
      changes: { instructions: "Be brief." },
    });
    expect(create.target.id).toBe(a.id);
    expect(rotate).toMatchObject({ target: { type: "widgets", id: w.widget.id }, changes: null });
    expect(action.changes.headers).toEqual({ Authorization: "[redacted]" });
    expect(JSON.stringify(log)).not.toContain("top-secret");

    // Streamed to the SIEM webhook, starting with its own creation.
    const jobs = await sql<{ payload: { event: string; body: string } }[]>`SELECT payload FROM jobs WHERE type = 'deliver_webhook' ORDER BY created_at`;
    const streamed = jobs.filter((j) => j.payload.event === "audit.recorded").map((j) => JSON.parse(j.payload.body).data.action);
    expect(streamed).toEqual(["webhooks.create", "assistants.create", "assistants.update", "widgets.create", "widgets.rotate-secret", "actions.create"]);
  });

  it("filters and pages", async () => {
    const byResource = await admin("GET", "/audit-log?action=assistants", undefined, 200);
    expect(byResource.items.map((e: { action: string }) => e.action)).toEqual(["assistants.update", "assistants.create"]);
    const exact = await admin("GET", "/audit-log?action=widgets.create", undefined, 200);
    expect(exact.items).toHaveLength(1);
    const target = exact.items[0].target.id;
    expect((await admin("GET", `/audit-log?targetId=${target}`)).items.map((e: { action: string }) => e.action)).toEqual(["widgets.rotate-secret", "widgets.create"]);
    const p1 = await admin("GET", "/audit-log?limit=4", undefined, 200);
    expect(p1.items).toHaveLength(4);
    const p2 = await admin("GET", `/audit-log?limit=4&cursor=${p1.nextCursor}`, undefined, 200);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items].map((e: { id: string }) => e.id);
    expect(new Set(all).size).toBe(all.length);
    expect((await admin("GET", "/audit-log?from=2999-01-01T00:00:00Z")).items).toEqual([]);
    await admin("GET", "/audit-log?from=yesterday", undefined, 400);
  });

  it("records exports, erasure and key revocation; purges old entries", async () => {
    const res = await app.request("/v1/admin/conversations/export", { headers: { authorization: `Bearer ${adminKey}` } });
    expect(res.status).toBe(200);
    await res.text();
    await admin("DELETE", "/subjects/user-42", undefined, 200);
    const k = await admin("POST", "/keys", { name: "temp" }, 201);
    expect((await admin("GET", "/audit-log?limit=1")).items[0]).toMatchObject({ action: "keys.create", target: { id: k.apiKey.id } });
    await admin("DELETE", `/keys/${k.apiKey.id}`, undefined, 204);
    const recent = (await admin("GET", "/audit-log?limit=4")).items.map((e: { action: string; target: { id: string } }) => `${e.action}:${e.target.id}`);
    expect(recent).toEqual([`keys.revoke:${k.apiKey.id}`, `keys.create:${k.apiKey.id}`, "subjects.erase:user-42", "conversations.export:null"]);

    await sql`UPDATE audit_log SET at = now() - interval '500 days' WHERE action = 'webhooks.create'`;
    expect(await purgeAudit(sql, 400)).toBe(1);
    expect(await purgeAudit(sql, 0)).toBe(0);
  });
});
