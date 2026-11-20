/**
 * Tools, confirmations, page tools, handoff, webhooks, privacy and insights,
 * end to end against Postgres (TEST_DATABASE_URL) and a local HTTP endpoint.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { JobWorker } from "../src/knowledge/jobs.js";
import { createLogger } from "../src/lib/log.js";
import { purgeExpired } from "../src/lib/retention.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { createServices } from "../src/services.js";
import { deliverWebhook } from "../src/webhooks/webhooks.js";

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://shop.example";

/** A deterministic "LLM" that calls tools based on the question. */
class AgentModel implements ChatModel {
  readonly id = "agent";
  readonly provider = "test";
  readonly model = "agent";
  requests: ChatRequest[] = [];
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    const has = (n: string) => req.tools?.some((t) => t.name === n);
    if (last.role === "tool") {
      yield { type: "text", text: `Done: ${last.results.map((r) => `${r.isError ? "ERR " : ""}${r.content}`).join(" | ")}` };
    } else {
      const q = req.question;
      const call = (name: string, input: Record<string, unknown>) => ({ type: "tool_call" as const, call: { id: `tu_${name}_${this.requests.length}`, name, input } });
      if (/status of order/.test(q) && has("get_order_status")) yield call("get_order_status", { orderId: "A-42" });
      else if (/broken args/.test(q) && has("get_order_status")) yield call("get_order_status", {});
      else if (/cancel order/.test(q) && has("cancel_order")) {
        yield { type: "text", text: "Let me cancel it." };
        yield call("cancel_order", { orderId: "A-42", reason: "changed mind" });
      } else if (/my cart/.test(q) && has("get_cart")) yield call("get_cart", {});
      else if (/human/.test(q) && has("handoff_to_human")) yield call("handoff_to_human", { reason: "wants a person" });
      else if (/search harder/.test(q) && has("search_knowledge")) yield call("search_knowledge", { query: "warranty period" });
      else yield { type: "text", text: `Answer to: ${q} [1]` };
    }
    yield { type: "usage", inputTokens: 10, outputTokens: 5 };
  }
}

/** Fast auxiliary model: query rewriting, follow-ups, summaries. */
class FastModel implements ChatModel {
  readonly id = "fast-test";
  readonly provider = "test";
  readonly model = "fast";
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const sys = req.system;
    if (/standalone search query/.test(sys)) yield { type: "text", text: "refund policy duration" };
    else if (/follow-up questions/.test(sys)) yield { type: "text", text: "1. How do I request a refund?\n- What about exchanges?\n" };
    else if (/Summarize a support conversation/.test(sys)) yield { type: "text", text: "- Visitor wants a person" };
    else yield { type: "text", text: "?" };
  }
}

interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

describe.skipIf(!DB)("agent features (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let base: string;
  const hits: Hit[] = [];
  const model = new AgentModel();
  let adminKey: string;
  let widgetId: string;
  let identitySecret: string;
  let webhookSecret: string;
  let assistantId: string;
  let worker: JobWorker;

  const req = (method: string, path: string, opts: { token?: string; body?: unknown; origin?: string | null } = {}) =>
    app.request(path, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  const admin = (method: string, path: string, body?: unknown, key = adminKey) => req(method, `/v1/admin${path}`, { token: key, body, origin: null });
  const json = async (res: Response | Promise<Response>, status?: number) => {
    const r = await res;
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const session = async () =>
    (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId: "agent-test-abcdefghijklmnop" } }), 201)).token as string;
  const newConv = async (token: string) => (await json(req("POST", "/v1/conversations", { token, body: {} }), 201)).id as string;
  const ask = async (token: string, conv: string, content: string, extra: Record<string, unknown> = {}) =>
    json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content, ...extra } }), 202);
  const waitEvent = async (runId: string, type: string, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ data: Record<string, any> }[]>`SELECT data FROM run_events WHERE run_id = ${runId} AND type = ${type} ORDER BY seq LIMIT 1`;
      if (rows[0]) return rows[0].data;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  const allEvents = async (runId: string) => {
    await waitEvent(runId, "run.completed").catch(async () => {
      const rows = await sql`SELECT type, data FROM run_events WHERE run_id = ${runId} ORDER BY seq`;
      throw new Error(`run did not complete: ${JSON.stringify(rows)}`);
    });
    return sql<{ type: string; data: Record<string, any> }[]>`SELECT type, data FROM run_events WHERE run_id = ${runId} ORDER BY seq`;
  };

  beforeAll(async () => {
    server = createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        hits.push({ method: rq.method!, url: rq.url!, headers: rq.headers, body });
        if (rq.url!.startsWith("/orders/") && rq.method === "GET") {
          rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "shipped", eta: "tomorrow" }));
        } else if (rq.url!.endsWith("/cancel")) {
          rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cancelled: true }));
        } else if (rq.url === "/hooks") {
          rs.writeHead(204).end();
        } else rs.writeHead(404).end("nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
    models.register(model, ["agent"]);
    models.register(new FastModel(), ["fast"]);
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    await s.bus.listen();
    app = createApp(s);
    worker = new JobWorker(sql, s.log, {
      ingest_source: async () => {},
      run_eval: async () => {},
      deliver_webhook: (job) => deliverWebhook({ sql, key: s.secretsKey, log: s.log, allowPrivate: true }, job),
    });

    const tenantId = await createTenant(sql, "Agent");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "test", k.hash, k.prefix);
    adminKey = k.key;
  });

  afterAll(async () => {
    server?.close();
    if (!sql) return;
    await s.executor.shutdown(5000);
    await sql.end({ timeout: 5 });
  });

  it("configures actions, a webhook and an agentic assistant", async () => {
    const src = await json(admin("POST", "/sources", { name: "Docs", type: "manual" }), 201);
    await json(admin("PUT", `/sources/${src.id}/documents`, { title: "Refund policy", content: "Refunds are possible within 30 days of purchase." }), 200);
    await json(admin("PUT", `/sources/${src.id}/documents`, { title: "Warranty", content: "The warranty period is two years for all devices." }), 200);

    await json(admin("POST", "/actions", { name: "search_knowledge", title: "x", description: "x", url: `${base}/x` }), 400);
    await json(admin("POST", "/actions", { name: "bad", title: "x", description: "x", url: "javascript:alert(1)" }), 400);
    const status = await json(
      admin("POST", "/actions", {
        name: "get_order_status",
        title: "Checking your order",
        description: "Look up the shipping status of an order by its id.",
        method: "GET",
        url: `${base}/orders/{orderId}`,
        parameters: { type: "object", properties: { orderId: { type: "string", minLength: 1 } }, required: ["orderId"] },
        headers: { Authorization: "Bearer shop-api-token" },
      }),
      201,
    );
    expect(status.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(status)).not.toContain("shop-api-token");
    await json(admin("POST", "/actions", { name: "get_order_status", title: "dup", description: "dup", url: `${base}/x` }), 409);
    const cancel = await json(
      admin("POST", "/actions", {
        name: "cancel_order",
        title: "Cancelling your order",
        description: "Cancel an order.",
        method: "POST",
        url: `${base}/orders/{orderId}/cancel`,
        parameters: { type: "object", properties: { orderId: { type: "string" }, reason: { type: "string" } }, required: ["orderId"] },
        confirm: true,
      }),
      201,
    );
    const tested = await json(admin("POST", `/actions/${status.id}/test`, { arguments: { orderId: "T-1" } }), 200);
    expect(tested).toMatchObject({ status: 200, isError: false });
    expect(JSON.parse(tested.output)).toEqual({ status: "shipped", eta: "tomorrow" });

    const hook = await json(admin("POST", "/webhooks", { url: `${base}/hooks`, events: ["handoff.requested", "message.completed", "feedback.submitted", "conversation.created"] }), 201);
    expect(hook.secret).toMatch(/^whsec_/);
    webhookSecret = hook.secret;
    expect((await json(admin("POST", `/webhooks/${hook.webhook.id}/test`), 200)).ok).toBe(true);

    await json(admin("POST", "/assistants", { name: "x", actionIds: ["act_missing"] }), 400);
    const a = await json(
      admin("POST", "/assistants", {
        name: "Shop help",
        modelAlias: "agent",
        sourceIds: [src.id],
        actionIds: [status.id, cancel.id],
        handoff: { enabled: true, message: "Our team will email you.", url: "https://shop.example/contact", label: null },
        redactPii: true,
      }),
      201,
    );
    expect(a).toMatchObject({ followUps: true, queryRewrite: true, agenticSearch: true, clientTools: true, redactPii: true });
    assistantId = a.id;
    const w = await json(admin("POST", "/widgets", { assistantId: a.id, name: "Shop", allowedOrigins: [ORIGIN] }), 201);
    widgetId = w.widget.id;
    identitySecret = w.identitySecret;
    const cfg = await json(req("GET", `/v1/widgets/${widgetId}/config`), 200);
    expect(cfg.handoff).toEqual({ enabled: true, url: "https://shop.example/contact", label: null });
  });

  it("calls a server action with signed requests and secret headers", async () => {
    const token = await session();
    const conv = await newConv(token);
    hits.length = 0;
    const run = await ask(token, conv, "What is the status of order A-42?");
    const evs = await allEvents(run.run.id);
    const types = evs.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["tool.started", "tool.completed", "message.completed", "message.suggestions", "run.completed"]));
    expect(evs.find((e) => e.type === "tool.started")!.data).toMatchObject({ name: "get_order_status", title: "Checking your order" });
    const answer = evs.find((e) => e.type === "message.completed")!.data.message;
    expect(answer.content).toContain('"status":"shipped"');
    expect(evs.find((e) => e.type === "message.suggestions")!.data.suggestions).toEqual(["How do I request a refund?", "What about exchanges?"]);

    const hit = hits.find((h) => h.url === "/orders/A-42")!;
    expect(hit.method).toBe("GET");
    expect(hit.headers.authorization).toBe("Bearer shop-api-token");
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["ea-signature"]))!;
    const expected = createHmac("sha256", identitySecret).update(`${sig[1]}.GET.${base}/orders/A-42..`).digest("hex");
    expect(sig[2]).toBe(expected);
    expect(hit.headers["ea-user-id"]).toBeUndefined(); // anonymous, requireUser=false

    // The transcript sent to the model on step 2 carries the tool call and its result.
    const second = model.requests.at(-1)!;
    expect(second.messages.at(-2)).toMatchObject({ role: "assistant", toolCalls: [{ name: "get_order_status" }] });
    expect(second.messages.at(-1)).toMatchObject({ role: "tool" });

    const msgs = await json(req("GET", `/v1/conversations/${conv}/messages`, { token }), 200);
    expect(msgs.items.at(-1).suggestions).toHaveLength(2);
  });

  it("returns validation errors to the model instead of calling the endpoint", async () => {
    const token = await session();
    const conv = await newConv(token);
    hits.length = 0;
    const run = await ask(token, conv, "broken args please");
    const evs = await allEvents(run.run.id);
    expect(evs.find((e) => e.type === "message.completed")!.data.message.content).toMatch(/ERR Invalid arguments: orderId/);
    expect(hits).toHaveLength(0);
  });

  it("asks the visitor before running a confirm action, and respects a refusal", async () => {
    const token = await session();
    const conv = await newConv(token);
    hits.length = 0;
    const run = await ask(token, conv, "Please cancel order A-42");
    const reqd = await waitEvent(run.run.id, "tool.input_required");
    expect(reqd).toMatchObject({ kind: "confirmation", name: "cancel_order", input: { orderId: "A-42" } });
    expect(hits).toHaveLength(0);
    await json(req("POST", `/v1/runs/${run.run.id}/tool-results`, { token, body: { callId: "call_unknown", approved: true } }), 404);
    await json(req("POST", `/v1/runs/${run.run.id}/tool-results`, { token, body: { callId: reqd.callId, approved: true } }), 204);
    await json(req("POST", `/v1/runs/${run.run.id}/tool-results`, { token, body: { callId: reqd.callId, approved: true } }), 409);
    const evs = await allEvents(run.run.id);
    const answer = evs.find((e) => e.type === "message.completed")!.data.message.content as string;
    // What the model wrote before the tool call was streamed, but the saved answer is what followed it.
    expect(evs.filter((e) => e.type === "message.delta").map((e) => e.data.text).join("")).toMatch(/^Let me cancel it\./);
    expect(answer).toMatch(/^Done: \{"cancelled":true\}/);
    const hit = hits.find((h) => h.url === "/orders/A-42/cancel")!;
    expect(JSON.parse(hit.body)).toEqual({ reason: "changed mind" });

    const run2 = await ask(token, conv, "Please cancel order A-42 again");
    const reqd2 = await waitEvent(run2.run.id, "tool.input_required");
    hits.length = 0;
    await json(req("POST", `/v1/runs/${run2.run.id}/tool-results`, { token, body: { callId: reqd2.callId, approved: false } }), 204);
    const evs2 = await allEvents(run2.run.id);
    expect(evs2.find((e) => e.type === "message.completed")!.data.message.content).toContain("declined");
    expect(hits).toHaveLength(0);
  });

  it("delegates page tools to the widget", async () => {
    const token = await session();
    const conv = await newConv(token);
    const run = await ask(token, conv, "What is in my cart?", {
      clientTools: [{ name: "get_cart", description: "Items in the visitor's cart", parameters: { type: "object", properties: {} } }],
    });
    const reqd = await waitEvent(run.run.id, "tool.input_required");
    expect(reqd).toMatchObject({ kind: "client", name: "get_cart" });
    // Someone else's session cannot answer.
    const other = (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId: "someone-else-abcdefghijklmn" } }), 201)).token;
    await json(req("POST", `/v1/runs/${run.run.id}/tool-results`, { token: other, body: { callId: reqd.callId, output: "x" } }), 404);
    await json(req("POST", `/v1/runs/${run.run.id}/tool-results`, { token, body: { callId: reqd.callId, output: { items: 2, total: "19.90 EUR" } } }), 204);
    const evs = await allEvents(run.run.id);
    expect(evs.find((e) => e.type === "message.completed")!.data.message.content).toContain('"total":"19.90 EUR"');
    // Invalid tool names are rejected up front.
    await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "x", clientTools: [{ name: "bad name", description: "x" }] } }), 400);
  });

  it("runs extra knowledge searches and keeps citation numbers stable", async () => {
    const token = await session();
    const conv = await newConv(token);
    const run = await ask(token, conv, "refund window? search harder");
    const evs = await allEvents(run.run.id);
    const retrievals = evs.filter((e) => e.type === "retrieval.completed");
    expect(retrievals.length).toBe(2);
    const titles = retrievals.at(-1)!.data.sources.map((x: { title: string }) => x.title);
    expect(titles).toContain("Warranty");
    expect(retrievals.at(-1)!.data.sources.map((x: { index: number }) => x.index)).toEqual(titles.map((_: unknown, i: number) => i + 1));
  });

  it("rewrites follow-up questions for retrieval and redacts personal data", async () => {
    const token = await session();
    const conv = await newConv(token);
    await allEvents((await ask(token, conv, "Tell me about refunds")).run.id);
    const run = await ask(token, conv, "and for how long? mail me at jane.doe@example.com");
    expect(run.userMessage.content).toBe("and for how long? mail me at [email]");
    await allEvents(run.run.id);
    const [r] = await sql<{ retrieval_query: string; source_count: number }[]>`SELECT retrieval_query, source_count FROM runs WHERE id = ${run.run.id}`;
    expect(r!.retrieval_query).toBe("refund policy duration");
    expect(r!.source_count).toBeGreaterThan(0);
    expect(model.requests.at(-1)!.question).not.toContain("jane.doe");

    const [answer] = await sql<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${conv} AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`;
    await json(req("POST", `/v1/messages/${answer!.id}/feedback`, { token, body: { rating: "down", comment: "wrong, write to jane.doe@example.com" } }), 204);
    const [fb] = await sql<{ feedback_comment: string }[]>`SELECT feedback_comment FROM messages WHERE id = ${answer!.id}`;
    expect(fb!.feedback_comment).toBe("wrong, write to [email]");
  });

  it("hands off to a human and delivers a signed webhook with the transcript", async () => {
    const token = await session();
    const conv = await newConv(token);
    const run = await ask(token, conv, "I want to talk to a human");
    const evs = await allEvents(run.run.id);
    expect(evs.find((e) => e.type === "handoff.requested")!.data).toEqual({ message: "Our team will email you.", url: "https://shop.example/contact" });
    expect(evs.some((e) => e.type === "message.suggestions")).toBe(false);
    const c = await json(req("GET", `/v1/conversations/${conv}`, { token }), 200);
    expect(c.handoffRequestedAt).toBeTruthy();

    // The visitor button on another conversation.
    const conv2 = await newConv(token);
    const h = await json(req("POST", `/v1/conversations/${conv2}/handoff`, { token, body: { reason: "call me +39 333 123 4567" } }), 200);
    expect(h.message).toBe("Our team will email you.");

    hits.length = 0;
    while (await worker.tick()) {
      /* drain the queue */
    }
    const deliveries = hits.filter((x) => x.url === "/hooks").map((x) => ({ x, payload: JSON.parse(x.body) }));
    const handoffs = deliveries.filter((d) => d.payload.type === "handoff.requested");
    expect(handoffs).toHaveLength(2);
    for (const { x } of deliveries) {
      const sig = createHmac("sha256", Buffer.from(webhookSecret.slice(6), "base64"))
        .update(`${x.headers["webhook-id"]}.${x.headers["webhook-timestamp"]}.${x.body}`)
        .digest("base64");
      expect(x.headers["webhook-signature"]).toBe(`v1,${sig}`);
    }
    const viaTool = handoffs.find((d) => d.payload.data.conversation.id === conv)!.payload.data;
    expect(viaTool).toMatchObject({ trigger: "assistant", reason: "wants a person", summary: "- Visitor wants a person" });
    expect(viaTool.transcript[0]).toMatchObject({ role: "user", content: "I want to talk to a human" });
    const viaButton = handoffs.find((d) => d.payload.data.conversation.id === conv2)!.payload.data;
    expect(viaButton).toMatchObject({ trigger: "visitor", reason: "call me [phone]" });
    expect(deliveries.some((d) => d.payload.type === "message.completed")).toBe(true);
    expect(deliveries.some((d) => d.payload.type === "conversation.created")).toBe(true);
  });

  it("reports insights", async () => {
    const ins = await json(admin("GET", "/insights?days=7"), 200);
    expect(ins.questions).toBeGreaterThan(5);
    expect(ins.handoffs).toBe(2);
    expect(ins.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "get_order_status", calls: 2, errors: 1 })]));
    expect(ins.topQuestions.length).toBeGreaterThan(0);
    // Handed-off conversations are not counted as resolved by the assistant.
    const r = ins.resolution;
    expect(r.handedOff).toBeGreaterThanOrEqual(1); // a handoff before any answer is not an engaged conversation
    expect(r.resolved).toBeLessThanOrEqual(r.engaged - r.handedOff);
    expect(r.rate).toBeCloseTo(r.resolved / r.engaged);
  });

  it("scopes API keys", async () => {
    const created = await json(admin("POST", "/keys", { name: "mcp client", scopes: ["mcp"], access: ["public"] }), 201);
    expect(created.key).toMatch(/^ea_mcp_/);
    expect((await admin("GET", "/assistants", undefined, created.key)).status).toBe(401);
    const adminCreated = await json(admin("POST", "/keys", { name: "ops", scopes: ["mcp"] }), 201);
    const list = await json(admin("GET", "/keys"), 200);
    expect(list.map((k: { name: string }) => k.name)).toEqual(expect.arrayContaining(["test", "mcp client", "ops"]));
    await json(admin("DELETE", `/keys/${adminCreated.apiKey.id}`), 204);
    expect((await json(admin("GET", "/keys"), 200)).length).toBe(list.length - 1);
  });

  it("deletes conversations permanently and applies retention", async () => {
    const token = await session();
    const conv = await newConv(token);
    await allEvents((await ask(token, conv, "hello there")).run.id);
    await json(req("DELETE", `/v1/conversations/${conv}`, { token }), 204);
    expect((await sql`SELECT 1 FROM messages WHERE conversation_id = ${conv}`).length).toBe(0);

    const old = await newConv(token);
    await sql`UPDATE conversations SET updated_at = now() - interval '40 days' WHERE id = ${old}`;
    expect(await purgeExpired(sql, 0)).toBe(0);
    await json(admin("PATCH", "/settings", { retentionDays: 30 }), 200);
    expect(await purgeExpired(sql, 0)).toBe(1);

    const exported = await (await admin("GET", "/conversations/export?days=7")).text();
    const lines = exported.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.some((l: { messages: unknown[] }) => l.messages.length > 0)).toBe(true);

    // Right of access: one subject's conversations, whatever their age.
    const subject = "anon:agent-test-abcdefghijklmnop";
    const older = await newConv(token);
    await sql`UPDATE conversations SET updated_at = now() - interval '20 days' WHERE id = ${older}`;
    const mine = (await (await admin("GET", `/conversations/export?subjectId=${encodeURIComponent(subject)}`)).text())
      .trim().split("\n").map((l) => JSON.parse(l) as { id: string; subjectId: string });
    expect(mine.every((l) => l.subjectId === subject)).toBe(true);
    expect(mine.map((l) => l.id)).toContain(older);
    expect((await (await admin("GET", "/conversations/export?subjectId=anon:nobody")).text()).trim()).toBe("");

    const erased = await json(admin("DELETE", `/subjects/${encodeURIComponent(subject)}`), 200);
    expect(erased.deletedConversations).toBeGreaterThan(3);
    void assistantId;
  });
});
