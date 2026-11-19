/** Live agent inbox: take over a handed-off chat, reply in real time, hand back. */
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

class RecordingModel implements ChatModel {
  readonly id = "rec";
  readonly provider = "test";
  readonly model = "rec";
  requests: ChatRequest[] = [];
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(req);
    yield { type: "text", text: `AI: ${req.question}` };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
  }
}

/** Read SSE frames from a streaming response until `until` matches or the time runs out. */
async function readEvents(res: Response, until: (events: { id: string | null; event: string; data: unknown }[]) => boolean, ms = 5000) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { id: string | null; event: string; data: unknown }[] = [];
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !until(events)) {
      const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), deadline - Date.now()))]);
      if (!r || r.done) break;
      buf += r.value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const get = (f: string) => block.split("\n").find((l) => l.startsWith(`${f}:`))?.slice(f.length + 1).trim() ?? null;
        const data = get("data");
        events.push({ id: get("id"), event: get("event") ?? "", data: data ? JSON.parse(data) : null });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

describe.skipIf(!DB)("agent inbox (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let widgetId: string;
  let token: string;
  let conv: string;
  const model = new RecordingModel();

  const req = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  const json = async (res: Response | Promise<Response>, status?: number) => {
    const r = await res;
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const admin = (method: string, path: string, body?: unknown) => json(req(method, `/v1/admin${path}`, { token: adminKey, body }));
  const waitRun = async (runId: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await json(req("GET", `/v1/runs/${runId}`, { token }));
      if (r.status !== "queued" && r.status !== "running") return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error("run did not finish");
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [], aliases: { standard: [] } });
    models.register(model, ["standard"]);
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    await s.bus.listen();
    app = createApp(s);
    const tenantId = await createTenant(sql, "Inbox");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "helpdesk-bridge", k.hash, k.prefix);
    adminKey = k.key;
    const a = await admin("POST", "/assistants", { name: "Help", handoff: { enabled: true, message: "A person will join.", url: null, label: null }, followUps: false, queryRewrite: false });
    const w = await admin("POST", "/widgets", { assistantId: a.id, name: "Shop", allowedOrigins: [ORIGIN] });
    widgetId = w.widget.id;
    token = (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId: "inbox-test-abcdefghijklmnop" } }), 201)).token;
    conv = (await json(req("POST", "/v1/conversations", { token, body: {} }), 201)).id;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("queues handed-off conversations and lets a person take over", async () => {
    const first = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "Where is my parcel?" } }), 202);
    await waitRun(first.run.id);
    expect((await admin("GET", "/conversations?handoff=waiting")).items).toEqual([]);
    await json(req("POST", `/v1/conversations/${conv}/handoff`, { token, body: { reason: "late parcel" } }), 200);
    const waiting = (await admin("GET", "/conversations?handoff=waiting")).items;
    expect(waiting.map((x: { id: string }) => x.id)).toEqual([conv]);
    expect(waiting[0]).toMatchObject({ mode: "assistant", assignee: null, handoffReason: "late parcel" });

    // Visitor is not in human mode yet: /messages is refused.
    await json(req("POST", `/v1/conversations/${conv}/messages`, { token, body: { content: "hello?" } }), 409);

    // The widget listens for conversation events while it waits.
    const stream = await req("GET", `/v1/conversations/${conv}/events`, { token });
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);
    const assigned = await admin("POST", `/conversations/${conv}/assign`, { displayName: "Maria" });
    expect(assigned).toMatchObject({ mode: "human", assignee: { id: null, name: "Maria" } });
    const reply = await json(req("POST", `/v1/admin/conversations/${conv}/reply`, { token: adminKey, body: { content: "Hi, I'm Maria. Let me check." } }), 201);
    expect(reply).toMatchObject({ role: "assistant", author: { type: "human", name: "Maria" }, content: "Hi, I'm Maria. Let me check." });

    const events = await readEvents(stream, (e) => e.filter((x) => x.event).length >= 2);
    const typed = events.filter((x) => x.event);
    expect(typed.map((e) => e.event)).toEqual(["conversation.updated", "message.created"]);
    expect((typed[0]!.data as { data: { conversation: unknown } }).data.conversation).toMatchObject({ id: conv, mode: "human", agentName: "Maria" });
    expect((typed[1]!.data as { data: { message: unknown } }).data.message).toMatchObject({ id: reply.id, author: { name: "Maria" } });

    // Resume from an event id: only later events.
    const later = req("GET", `/v1/conversations/${conv}/events`, { token, headers: { "last-event-id": typed[0]!.id! } });
    const resumed = await readEvents(await later, (e) => e.some((x) => x.event === "message.created"));
    expect(resumed.filter((x) => x.event).map((e) => e.event)).toEqual(["message.created"]);

    expect((await admin("GET", "/conversations?handoff=active")).items.map((x: { id: string }) => x.id)).toEqual([conv]);
    expect(await admin("GET", `/conversations/${conv}`)).toMatchObject({ id: conv, mode: "human", assignee: { name: "Maria" }, messageCount: 3 });
    expect((await json(req("GET", `/v1/conversations/${conv}`, { token }))).mode).toBe("human");
  });

  it("routes visitor messages to the person, not the AI", async () => {
    const before = model.requests.length;
    const refused = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "Any news?" } }), 409);
    expect(refused.error.details).toEqual({ mode: "human" });
    await admin("POST", "/webhooks", { url: "https://helpdesk.example/hook", events: ["message.received"] });
    const sent = await json(req("POST", `/v1/conversations/${conv}/messages`, { token, body: { content: "Any news?" } }), 201);
    expect(sent).toMatchObject({ role: "user", content: "Any news?" });
    expect(model.requests.length).toBe(before);
    let job: { payload: { event: string; body: string } } | undefined;
    for (let i = 0; i < 50 && !job; i++) {
      [job] = await sql<{ payload: { event: string; body: string } }[]>`SELECT payload FROM jobs WHERE type = 'deliver_webhook' AND payload->>'event' = 'message.received'`;
      if (!job) await new Promise((ok) => setTimeout(ok, 20));
    }
    const hook = JSON.parse(job!.payload.body);
    expect(hook.data).toMatchObject({ conversationId: conv, message: { content: "Any news?" }, assignee: { name: "Maria" } });

    // Someone else cannot silently take over.
    await json(req("POST", `/v1/admin/conversations/${conv}/assign`, { token: adminKey, body: { displayName: "Bob" } }), 409);
    const msgs = await json(req("GET", `/v1/admin/conversations/${conv}/messages`, { token: adminKey }));
    expect(msgs.items.map((m: { content: string }) => m.content)).toEqual(["Where is my parcel?", "AI: Where is my parcel?", "Hi, I'm Maria. Let me check.", "Any news?"]);
  });

  it("hands back to the assistant, which sees what the person said", async () => {
    const released = await admin("POST", `/conversations/${conv}/release`, {});
    expect(released).toMatchObject({ mode: "assistant", assignee: null });
    expect(released.handoffResolvedAt).not.toBeNull();
    expect((await admin("GET", "/conversations?handoff=resolved")).items).toHaveLength(1);
    expect((await admin("GET", "/conversations?handoff=waiting")).items).toHaveLength(0);
    const run = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "Thanks, one more question" } }), 202);
    await waitRun(run.run.id);
    const history = JSON.stringify(model.requests.at(-1)!.messages);
    expect(history).toContain("[Maria, a person on the support team, wrote:] Hi, I'm Maria. Let me check.");
    // A new handoff puts it back in the queue.
    await json(req("POST", `/v1/conversations/${conv}/handoff`, { token, body: {} }), 200);
    expect((await admin("GET", "/conversations?handoff=waiting")).items).toHaveLength(1);
  });
});
