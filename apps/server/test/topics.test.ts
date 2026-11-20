/** Question topics, suggested docs and the weekly digest. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { analyzeTopicsJob, groupByKeywords, parseJsonObject, scheduleDigests, topicOf, type QuestionStat } from "../src/insights/topics.js";
import { JobWorker } from "../src/knowledge/jobs.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { createServices } from "../src/services.js";

const q = (text: string, count = 1, problems: Partial<Pick<QuestionStat, "unanswered" | "downvoted" | "handoffs">> = {}): QuestionStat => ({
  text,
  count,
  conversations: new Set([`c-${text}`]),
  unanswered: 0,
  downvoted: 0,
  handoffs: 0,
  ...problems,
});

describe("topics (unit)", () => {
  it("groups by shared words without a model", () => {
    const groups = groupByKeywords([q("How do I get a refund?", 3), q("refund for my order", 2), q("Reset my password"), q("password reset link expired")]);
    expect(groups.map((g) => g.members.length)).toEqual([2, 2]);
    expect(groups[0]!.name).toBe("How do I get a refund?");
  });

  it("measures each topic", () => {
    const t = topicOf("Refunds", [q("refund?", 4, { unanswered: 2, downvoted: 1 }), q("money back", 1, { handoffs: 1 })]);
    expect(t).toMatchObject({ questions: 5, conversations: 2, unanswered: 2, downvoted: 1, handoffs: 1, problemRate: 0.8, examples: ["refund?", "money back"] });
  });

  it("reads JSON from chatty model replies", () => {
    expect(parseJsonObject('Sure:\n```json\n{"topics":[]}\n```')).toEqual({ topics: [] });
    expect(parseJsonObject("no json")).toBeNull();
    expect(parseJsonObject(null)).toBeNull();
  });
});

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://shop.example";

/** Answers questions, groups them, and suggests articles. */
class AnalystModel implements ChatModel {
  readonly id = "analyst";
  readonly provider = "test";
  readonly model = "analyst";
  prompts: string[] = [];
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const last = req.messages.at(-1)!;
    const text = last.role === "user" ? last.content : "";
    if (req.system.includes("group questions")) {
      this.prompts.push(text);
      const lines = [...text.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), q: m[2]!.toLowerCase() }));
      const refunds = lines.filter((l) => l.q.includes("refund")).map((l) => l.n);
      const login = lines.filter((l) => l.q.includes("password") || l.q.includes("log in")).map((l) => l.n);
      // Number 999 does not exist and must be ignored; unlisted questions land in "Other".
      yield { type: "text", text: `Here you go:\n{"topics":[{"name":"Refunds","questions":[${refunds.join(",")},999]},{"name":"Login problems","questions":[${login.join(",")}]}]}` };
    } else if (req.system.includes("help articles")) {
      this.prompts.push(text);
      yield { type: "text", text: '{"action":"write","title":"How refunds work","outline":["Who can get a refund","How long it takes"]}' };
    } else {
      yield { type: "text", text: "An answer." };
    }
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
  }
}

describe.skipIf(!DB)("topics (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let tenantId: string;
  let widgetId: string;
  const model = new AnalystModel();
  let worker: JobWorker;
  const deliveries: { type: string; data: Record<string, unknown> }[] = [];

  const req = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
    app.request(path, {
      method,
      headers: { origin: ORIGIN, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  const json = async (res: Response | Promise<Response>, status?: number) => {
    const r = await res;
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const admin = (method: string, path: string, body?: unknown, status?: number) => json(req(method, `/v1/admin${path}`, { token: adminKey, body }), status);
  const ask = async (content: string) => {
    const token = (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId: `topics-${Math.random().toString(36).slice(2)}-abcdefghijklmnop` } }), 201)).token;
    const conv = (await json(req("POST", "/v1/conversations", { token, body: {} }), 201)).id;
    const r = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content } }), 202);
    for (let i = 0; i < 100; i++) {
      const run = await json(req("GET", `/v1/runs/${r.run.id}`, { token }));
      if (run.status !== "queued" && run.status !== "running") break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    return { token, conv };
  };
  const drain = async () => {
    for (let i = 0; i < 20 && (await worker.tick()); i++);
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: process.env.TEST_LOG ?? "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [], aliases: { standard: [] } });
    models.register(model, ["standard"]);
    s = createServices(cfg, { sql, log: createLogger((process.env.TEST_LOG ?? "silent") as "silent"), models });
    app = createApp(s);
    worker = new JobWorker(sql, s.log, {
      analyze_topics: (job) => analyzeTopicsJob({ sql, models, log: s.log, publicBaseUrl: "https://assist.example" }, job),
      deliver_webhook: async (job) => {
        deliveries.push(JSON.parse(String(job.payload.body)));
      },
    });
    tenantId = await createTenant(sql, "Topics");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "ci", k.hash, k.prefix);
    adminKey = k.key;
    const src = await admin("POST", "/sources", { name: "Docs", type: "manual" }, 201);
    await admin("PUT", `/sources/${src.id}/documents`, { title: "Refund policy", content: "# Refunds\n\nRefunds are possible within 30 days of purchase." }, 200);
    const a = await admin("POST", "/assistants", { name: "Help", followUps: false, queryRewrite: false, sourceIds: [src.id] }, 201);
    widgetId = (await admin("POST", "/widgets", { assistantId: a.id, name: "Shop", allowedOrigins: [ORIGIN] }, 201)).widget.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("groups questions into topics with outcomes and a suggested article", async () => {
    await ask("Are refunds possible?");
    await ask("are  refunds possible?");
    await ask("Refunds possible after 30 days?");
    const { conv } = await ask("I forgot my password");
    await ask("I cannot log in");
    await ask("Hello");
    await sql`UPDATE conversations SET handoff_at = now() WHERE id = ${conv}`;

    const started = await admin("POST", "/insights/topics", { days: 7 }, 202);
    expect(started).toMatchObject({ status: "queued", trigger: "manual", days: 7 });
    await admin("POST", "/insights/topics", { days: 7 }, 409);
    await drain();
    const r = await admin("GET", `/insights/topics/${started.id}`, undefined, 200);
    expect(r).toMatchObject({ status: "completed", method: "model", questionCount: 5 });
    const names = r.topics.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Refunds", "Login problems", "Other"]));
    const refunds = r.topics.find((t: { name: string }) => t.name === "Refunds");
    expect(refunds).toMatchObject({ questions: 3, conversations: 3, unanswered: 0, problemRate: 0, suggestion: null });
    expect(refunds.relatedDocuments[0].title).toBe("Refund policy");
    const login = r.topics.find((t: { name: string }) => t.name === "Login problems");
    // No knowledge about logins: every question is a problem, so it comes first with a suggested article.
    expect(login).toMatchObject({ unanswered: 2, problemRate: 1, suggestion: { action: "write", title: "How refunds work" } });
    expect(r.topics[0].name).toBe("Login problems");
    expect(r.topics.at(-1).name).toBe("Other");
    expect(r.summary).toMatchObject({ conversations: 6, questions: 6 });
    // The questions went to the model as data, deduplicated.
    expect(model.prompts[0]!.match(/are refunds possible/gi)).toHaveLength(1);

    const list = await admin("GET", "/insights/topics", undefined, 200);
    expect(list.items[0].id).toBe(started.id);
    const audit = await admin("GET", "/audit-log?action=insights", undefined, 200);
    expect(audit.items[0].action).toBe("insights.analyze-topics");
  });

  it("sends a weekly digest to tenants that ask for it", async () => {
    expect(await scheduleDigests(sql)).toBe(0);
    expect((await admin("GET", "/settings")).weeklyDigest).toBe(false);
    await admin("PATCH", "/settings", { weeklyDigest: true }, 200);
    await admin("POST", "/webhooks", { url: "https://hooks.example/digest", events: ["insights.digest"] }, 201);
    expect(await scheduleDigests(sql)).toBe(1);
    expect(await scheduleDigests(sql)).toBe(0); // not again within the week
    await drain();
    const digest = deliveries.find((d) => d.type === "insights.digest");
    expect(digest?.data).toMatchObject({ period: { days: 7 }, url: "https://assist.example/admin/#/insights", summary: { conversations: 6 } });
    expect((digest!.data.topics as { name: string }[]).length).toBeGreaterThan(0);
    // Suspended tenants get none.
    await sql`UPDATE topic_reports SET created_at = now() - interval '8 days' WHERE tenant_id = ${tenantId}`;
    await sql`UPDATE tenants SET status = 'suspended' WHERE id = ${tenantId}`;
    expect(await scheduleDigests(sql)).toBe(0);
    await sql`UPDATE tenants SET status = 'active' WHERE id = ${tenantId}`;
  });
});
