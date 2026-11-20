/** Images visitors attach to a question (screenshots) for vision models. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { cleanName, sniffImage } from "../src/attachments/attachments.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { createLogger } from "../src/lib/log.js";
import { purgeExpired } from "../src/lib/retention.js";
import { toAnthropicMessages } from "../src/models/anthropic.js";
import { toOpenAIMessages } from "../src/models/openaiCompatible.js";
import { ModelRegistry, withoutImages } from "../src/models/registry.js";
import type { ChatChunk, ChatModel, ChatRequest } from "../src/models/types.js";
import { createServices } from "../src/services.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const SVG = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));

describe("attachments (unit)", () => {
  it("detects the type from the bytes, never from the name", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Uint8Array.from(Buffer.from("GIF89a....")))).toBe("image/gif");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("cleans display names", () => {
    expect(cleanName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanName("shot\u0000.png")).toBe("shot.png");
    expect(cleanName("   ")).toBeNull();
  });

  it("maps images to each provider's format", () => {
    const turns = [{ role: "user" as const, content: "What is this?", images: [{ mediaType: "image/png" as const, data: "AAAA" }] }];
    expect(toAnthropicMessages(turns)[0]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "What is this?" },
      ],
    });
    expect(toOpenAIMessages(turns)[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    // Plain turns keep the plain string form every server understands.
    expect(toOpenAIMessages([{ role: "user", content: "Hi" }])[0]).toEqual({ role: "user", content: "Hi" });
  });

  it("replaces images with a note for models that cannot see them", () => {
    const req = { system: "", question: "q", sources: [], maxOutputTokens: 1, signal: new AbortController().signal };
    const out = withoutImages({ ...req, messages: [{ role: "user", content: "Look", images: [{ mediaType: "image/png", data: "A" }, { mediaType: "image/png", data: "B" }] }] });
    expect(out.messages[0]).toEqual({ role: "user", content: expect.stringContaining("attached 2 images, but you cannot see images") });
    expect(JSON.stringify(out)).not.toContain('"images"');
  });
});

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://shop.example";

/** Reports how many images it received and the user turn text. */
class EyeModel implements ChatModel {
  readonly provider = "test";
  readonly model = "eye";
  requests: ChatRequest[] = [];
  constructor(
    readonly id: string,
    readonly vision: boolean,
  ) {}
  available() {
    return true;
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (!req.tools && req.system.includes("follow-up")) return;
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    const n = last.role === "user" ? (last.images?.length ?? 0) : 0;
    const bytes = last.role === "user" ? (last.images ?? []).map((i) => `${i.mediaType}:${Buffer.from(i.data, "base64").length}`).join(",") : "";
    yield { type: "text", text: `saw ${n} [${bytes}]` };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
  }
}

describe.skipIf(!DB)("attachments (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let adminKey: string;
  let assistantId: string;
  let widgetId: string;
  const eye = new EyeModel("eye", true);
  const blind = new EyeModel("blind", false);

  const req = (method: string, path: string, opts: { token?: string; body?: unknown; raw?: Uint8Array; type?: string } = {}) =>
    app.request(path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.raw ? { "content-type": opts.type ?? "application/octet-stream" } : {}),
      },
      body: opts.raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  const json = async (res: Response | Promise<Response>, status?: number) => {
    const r = await res;
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };
  const admin = (method: string, path: string, body?: unknown, status?: number) => json(req(method, `/v1/admin${path}`, { token: adminKey, body }), status);
  const session = async (anonymousId: string) => (await json(req("POST", "/v1/sessions", { body: { widgetId, anonymousId } }), 201)).token as string;
  const conversation = async (token: string) => (await json(req("POST", "/v1/conversations", { token, body: {} }), 201)).id as string;
  const upload = (token: string, conv: string, data: Uint8Array, name = "shot.png") =>
    req("POST", `/v1/conversations/${conv}/attachments?name=${encodeURIComponent(name)}`, { token, raw: data, type: "image/png" });
  const ask = async (token: string, conv: string, body: Record<string, unknown>) => {
    const r = await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body }), 202);
    for (let i = 0; i < 100; i++) {
      const run = await json(req("GET", `/v1/runs/${r.run.id}`, { token }));
      if (run.status !== "queued" && run.status !== "running") break;
      await new Promise((ok) => setTimeout(ok, 30));
    }
    const msgs = await json(req("GET", `/v1/conversations/${conv}/messages`, { token }));
    return { created: r, answer: msgs.items.at(-1).content as string, messages: msgs.items };
  };

  beforeAll(async () => {
    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({ SECRET_KEY: "test-secret-key-0123456789abcdefghijkl", DATABASE_URL: DB, LOG_LEVEL: process.env.TEST_LOG ?? "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const models = new ModelRegistry({ deployments: [], aliases: { standard: [] } });
    models.register(eye, ["standard"]);
    models.register(blind, ["text-only"]);
    s = createServices(cfg, { sql, log: createLogger((process.env.TEST_LOG ?? "silent") as "silent"), models });
    app = createApp(s);
    const tenantId = await createTenant(sql, "Attachments");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "ci", k.hash, k.prefix);
    adminKey = k.key;
    assistantId = (await admin("POST", "/assistants", { name: "Help", followUps: false, queryRewrite: false }, 201)).id;
    const w = await admin("POST", "/widgets", { assistantId, name: "Shop", allowedOrigins: [ORIGIN] }, 201);
    expect(w.widget.features.attachments).toBe(false);
    widgetId = w.widget.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("is off unless the widget enables it", async () => {
    expect((await json(req("GET", `/v1/widgets/${widgetId}/config`))).features.attachments).toBe(false);
    const token = await session("att-visitor-aaaaaaaaaaaaaaaa");
    const conv = await conversation(token);
    await json(upload(token, conv, PNG), 400);
    await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "Hi", attachmentIds: ["att_x"] } }), 400);
  });

  it("sends uploaded images to a vision model with the question", async () => {
    await admin("PATCH", `/widgets/${widgetId}`, { features: { attachments: true } }, 200);
    const token = await session("att-visitor-bbbbbbbbbbbbbbbb");
    const conv = await conversation(token);
    let cfg = await json(req("GET", `/v1/widgets/${widgetId}/config`));
    // The widget cache may hold the old row for a moment.
    for (let i = 0; i < 40 && !cfg.features.attachments; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      cfg = await json(req("GET", `/v1/widgets/${widgetId}/config`));
    }
    expect(cfg.features.attachments).toBe(true);

    // Only real images; the declared type is ignored.
    await json(upload(token, conv, SVG), 400);
    await json(upload(token, conv, new Uint8Array()), 400);
    const a = await json(upload(token, conv, PNG, "../error shot.png"), 201);
    expect(a).toMatchObject({ mediaType: "image/png", name: ".._error shot.png", size: PNG.length });
    const b = await json(upload(token, conv, JPEG, "photo.jpg"), 201);
    expect(b.mediaType).toBe("image/jpeg");

    // Another visitor can neither read nor send them.
    const other = await session("att-visitor-cccccccccccccccc");
    const otherConv = await conversation(other);
    await json(req("GET", `/v1/conversations/${conv}/attachments/${a.id}`, { token: other }), 404);
    await json(req("POST", `/v1/conversations/${otherConv}/runs`, { token: other, body: { content: "Hi", attachmentIds: [a.id] } }), 400);

    const { created, answer, messages } = await ask(token, conv, { content: "What is wrong here?", attachmentIds: [b.id, a.id] });
    expect(answer).toBe(`saw 2 [image/jpeg:${JPEG.length},image/png:${PNG.length}]`);
    expect(created.userMessage.attachments.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
    expect(messages[0].attachments).toHaveLength(2);
    const turn = eye.requests.at(-1)!.messages.at(-1)!;
    expect(turn.role === "user" && turn.content).toContain("attached 2 images");

    // The owner can download them, served as an image only.
    const img = await req("GET", `/v1/conversations/${conv}/attachments/${a.id}`, { token });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    const adm = await req("GET", `/v1/admin/conversations/${conv}/attachments/${a.id}`, { token: adminKey });
    expect(adm.status).toBe(200);

    // A sent image cannot be sent again or removed; the next turn only mentions it.
    await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "again", attachmentIds: [a.id] } }), 400);
    await json(req("DELETE", `/v1/conversations/${conv}/attachments/${a.id}`, { token }), 404);
    const next = await ask(token, conv, { content: "And now?" });
    expect(next.answer).toBe("saw 0 []");
    const history = eye.requests.at(-1)!.messages.find((m) => m.role === "user");
    expect(history?.role === "user" && history.content).toContain("attached 2 image(s)");
  });

  it("limits pending uploads and removes unsent ones", async () => {
    const token = await session("att-visitor-dddddddddddddddd");
    const conv = await conversation(token);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await json(upload(token, conv, PNG), 201)).id);
    await json(upload(token, conv, PNG), 400);
    await json(req("POST", `/v1/conversations/${conv}/runs`, { token, body: { content: "five", attachmentIds: ids.slice(0, 5) } }), 400);
    await json(req("DELETE", `/v1/conversations/${conv}/attachments/${ids[0]}`, { token }), 204);
    await json(upload(token, conv, PNG), 201);

    // Unsent uploads older than a day are purged; deleting the conversation removes the rest.
    await sql`UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = ${ids[1]!}`;
    await purgeExpired(sql, 0);
    expect((await sql`SELECT 1 FROM attachments WHERE id = ${ids[1]!}`).length).toBe(0);
    await json(req("DELETE", `/v1/conversations/${conv}`, { token }), 204);
    expect((await sql`SELECT count(*)::int AS n FROM attachments WHERE conversation_id = ${conv}`)[0]!.n).toBe(0);
  });

  it("tells a model without vision that an image was attached", async () => {
    await admin("PATCH", `/assistants/${assistantId}`, { modelAlias: "text-only" }, 200);
    const cfg = await json(req("GET", `/v1/widgets/${widgetId}/config`));
    expect(cfg.features.attachments).toBe(false);
    const token = await session("att-visitor-eeeeeeeeeeeeeeee");
    const conv = await conversation(token);
    await json(upload(token, conv, PNG), 400);
    await admin("PATCH", `/assistants/${assistantId}`, { modelAlias: "standard" }, 200);
  });
});
