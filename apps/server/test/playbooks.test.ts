/** Playbooks, answer style and multi-turn evaluation cases. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { runEvalJob } from "../src/evals/evals.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { JobWorker } from "../src/knowledge/jobs.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { buildSystemPrompt } from "../src/runs/prompt.js";
import { createServices } from "../src/services.js";

describe("answer style and playbook prompt", () => {
  const base = { assistantName: "Help", instructions: "", groundedOnly: true };
  it("applies length and tone rules", () => {
    expect(buildSystemPrompt(base)).toContain("Be concise and helpful.");
    const short = buildSystemPrompt({ ...base, style: { tone: "formal", length: "short" } });
    expect(short).toContain("two to four sentences");
    expect(short).toContain("formal, professional tone");
    expect(short).not.toContain("Be concise and helpful.");
    expect(buildSystemPrompt({ ...base, style: { tone: "neutral", length: "detailed" } })).toContain("thorough, complete answers");
  });
  it("lists playbooks by name and description only", () => {
    const p = buildSystemPrompt({ ...base, playbooks: [{ name: "refund_request", description: "Customer wants\\nmoney back." }] });
    expect(p).toContain("call open_playbook");
    expect(p).toContain("- refund_request: Customer wants\\nmoney back.");
    expect(buildSystemPrompt(base)).not.toContain("Playbooks");
  });
});

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://shop.example";

/** Opens a playbook for refund questions and answers with what it read; echoes earlier turns. */
class PlaybookModel implements ChatModel {
  readonly id = "pb";
  readonly provider = "test";
  readonly model = "pb";
  requests: ChatRequest[] = [];
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (!req.tools && /follow-up|standalone|grade answers|safety classifier/.test(req.system)) return;
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    if (last.role === "tool") {
      yield { type: "text", text: `Following: ${last.results[0]!.content.split("\n\n")[1]}` };
    } else if (/refund/i.test(req.question) && req.tools?.some((t) => t.name === "open_playbook")) {
      yield { type: "tool_call", call: { id: "tu_pb", name: "open_playbook", input: { name: "refund_request" } } };
    } else {
      const earlier = req.messages.filter((m) => m.role === "user").length - 1;
      yield { type: "text", text: `Plain answer (${earlier} earlier user turns)` };
    }
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
  }
}

describe.skipIf(!DB)("playbooks (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let token: string;
  let assistantId: string;
  const model = new PlaybookModel();

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
    const conv = (await json(req("POST", "/v1/conversations", { token, body: {} }), 201)).id;
    const r = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content } }), 202);
    for (let i = 0; i < 100; i++) {
      const run = await json(req("GET", `/v1/runs/${r.run.id}`, { token }));
      if (run.status !== "queued" && run.status !== "running") break;
      await new Promise((ok) => setTimeout(ok, 30));
    }
    const msgs = await json(req("GET", `/v1/conversations/${conv}/messages`, { token }));
    return { answer: msgs.items.at(-1).content as string, conv };
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [], aliases: { standard: [] } });
    models.register(model, ["standard"]);
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    app = createApp(s);
    const tenantId = await createTenant(sql, "Playbooks");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "ci", k.hash, k.prefix);
    adminKey = k.key;
    const a = await admin("POST", "/assistants", { name: "Help", followUps: false, queryRewrite: false }, 201);
    expect(a).toMatchObject({ playbookIds: [], style: { tone: "neutral", length: "medium" } });
    assistantId = a.id;
    const w = await admin("POST", "/widgets", { assistantId, name: "Shop", allowedOrigins: [ORIGIN] }, 201);
    token = (await json(req("POST", "/v1/sessions", { body: { widgetId: w.widget.id, anonymousId: "playbook-test-abcdefghijklmnop" } }), 201)).token;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("manages playbooks and follows them on demand", async () => {
    await admin("POST", "/playbooks", { name: "Refund Request", title: "Refunds", description: "When a customer asks for money back.", instructions: "x" }, 400);
    const pb = await admin("POST", "/playbooks", {
      name: "refund_request", title: "Refunds", description: "When a customer asks for money back for an order.",
      instructions: "1. Ask for the order number.\n2. Check it is under 30 days old.",
    }, 201);
    expect(pb).toMatchObject({ name: "refund_request", enabled: true });
    await admin("POST", "/playbooks", { name: "refund_request", title: "Dup", description: "Duplicate playbook name here.", instructions: "x" }, 409);
    await admin("POST", "/actions", { name: "open_playbook", title: "x", description: "Clashes with a built-in tool", method: "GET", url: "https://api.example/x" }, 400);
    await admin("PATCH", `/assistants/${assistantId}`, { playbookIds: ["pbk_missing"] }, 400);
    await admin("PATCH", `/assistants/${assistantId}`, { playbookIds: [pb.id], style: { tone: "friendly", length: "short" } }, 200);

    const { answer, conv } = await ask("I want a refund please");
    expect(answer).toBe("Following: 1. Ask for the order number.\n2. Check it is under 30 days old.");
    const sys = model.requests.at(-1)!.system;
    expect(sys).toContain("- refund_request: When a customer asks for money back for an order.");
    expect(sys).toContain("warm, friendly");
    expect(sys).not.toContain("Ask for the order number"); // steps are read on demand only
    const [trace] = (await admin("GET", `/conversations/${conv}/runs`)).items;
    expect(trace.tools).toMatchObject([{ name: "open_playbook", kind: "server", isError: false }]);

    // Disabled playbooks are not offered.
    await admin("PATCH", `/playbooks/${pb.id}`, { enabled: false }, 200);
    expect((await ask("I want a refund please")).answer).toBe("Plain answer (0 earlier user turns)");
    await admin("PATCH", `/playbooks/${pb.id}`, { enabled: true }, 200);

    // Deleting detaches it from assistants.
    const other = await admin("POST", "/playbooks", { name: "other", title: "Other", description: "Something else entirely.", instructions: "Do it." }, 201);
    await admin("PATCH", `/assistants/${assistantId}`, { playbookIds: [pb.id, other.id] }, 200);
    await admin("DELETE", `/playbooks/${other.id}`, undefined, 204);
    expect((await admin("GET", `/assistants/${assistantId}`)).playbookIds).toEqual([pb.id]);
    expect((await admin("GET", "/audit-log")).items.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["playbooks.create", "playbooks.update", "playbooks.delete"]));
  });

  it("evaluates multi-turn cases and playbooks", async () => {
    const suite = await admin("POST", "/evals", { name: "Flows", assistantId }, 201);
    const added = await admin("POST", `/evals/${suite.id}/cases`, {
      cases: [
        { question: "And the second one?", history: [{ role: "user", content: "What are the steps?" }, { role: "assistant", content: "There are two." }], mustInclude: ["1 earlier user turns"] },
        { question: "Refund my order", mustInclude: ["order number"] },
      ],
    }, 201);
    expect(added.items[0].history).toHaveLength(2);
    expect(added.items[1].history).toEqual([]);
    await admin("PATCH", `/evals/${suite.id}/cases/${added.items[1].id}`, { tags: ["refunds"] }, 200);
    const run = await admin("POST", `/evals/${suite.id}/runs`, { judge: false }, 202);
    const worker = new JobWorker(sql, s.log, { ingest_source: async () => {}, deliver_webhook: async () => {}, run_eval: (job) => runEvalJob({ sql, models: s.models, log: s.log }, job) });
    while (await worker.tick(["run_eval"])) {}
    const done = await admin("GET", `/eval-runs/${run.id}`);
    expect(done).toMatchObject({ status: "completed", passed: 2, total: 2 });
  });
});
