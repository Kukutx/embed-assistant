/**
 * Knowledge ingestion: file uploads (PDF, DOCX, Markdown), llms.txt and PDF
 * crawling, source edits that re-tag passages, and scheduled re-syncs.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAdminKey } from "../src/auth/adminKey.js";
import { loadConfig } from "../src/config.js";
import { createSql, type Sql } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createTenant, insertAdminKey } from "../src/db/store.js";
import { createApp } from "../src/http/app.js";
import type { Services } from "../src/http/env.js";
import { crawlScope, inScope, normalizeUrl, parseRobots, robotsAllows } from "../src/knowledge/crawl.js";
import { detectKind, extractDocument, parseLlmsTxt } from "../src/knowledge/extract.js";
import { ingestSource, scheduleDueSyncs, upsertDocument } from "../src/knowledge/ingest.js";
import { retrieve } from "../src/knowledge/retrieve.js";
import { parseRerank } from "../src/models/rerank.js";
import { createLogger } from "../src/lib/log.js";
import { ModelRegistry } from "../src/models/registry.js";
import { createServices } from "../src/services.js";

const DB = process.env.TEST_DATABASE_URL;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("document extraction", () => {
  it("detects kinds from type, name and bytes", () => {
    expect(detectKind("", "x.bin", fixture("returns.pdf"))).toBe("pdf");
    expect(detectKind("application/octet-stream", "shipping.docx", fixture("shipping.docx"))).toBe("docx");
    expect(detectKind("", "fake.docx", Buffer.from("not a zip"))).toBeNull();
    expect(detectKind("text/plain", "a.txt", Buffer.from("<!doctype html><p>x"))).toBe("html");
    expect(detectKind("", "README.md", Buffer.from("# Hi"))).toBe("markdown");
    expect(detectKind("", "blob", Buffer.from([0, 1, 2, 3, 255, 254]))).toBeNull();
  });

  it("reads PDF pages, DOCX headings and Markdown front matter", async () => {
    const pdf = await extractDocument(fixture("returns.pdf"), { contentType: "application/pdf", name: "returns.pdf" });
    expect(pdf.title).toBe("Returns guide");
    expect(pdf.text).toMatch(/## Page 1\s+Returns are accepted within 45 days[\s\S]*## Page 2\s+Refunds reach your card/);
    const docx = await extractDocument(fixture("shipping.docx"), { contentType: "", name: "shipping.docx" });
    expect(docx).toMatchObject({ title: "Shipping policy" });
    expect(docx.text).toContain("## Express");
    const md = await extractDocument(Buffer.from("---\ntitle: \"FAQ page\"\n---\n# Ignored heading\nBody"), { contentType: "text/markdown", name: "faq.md" });
    expect(md).toEqual({ title: "FAQ page", text: "# Ignored heading\nBody" });
    await expect(extractDocument(Buffer.from([0, 1, 2, 255]), { contentType: "image/png", name: "a.png" })).rejects.toThrow(/unsupported/);
  });

  it("reads rerank responses in their common shapes", () => {
    expect(parseRerank({ results: [{ index: 1, relevance_score: 0.2 }, { index: 0, relevance_score: 0.9 }] }, 2)).toEqual([0, 1]);
    expect(parseRerank({ data: [{ index: 2, relevance_score: 0.5 }, { index: 7, relevance_score: 1 }] }, 3)).toEqual([2]);
    expect(parseRerank([{ index: 0, score: 0.1 }, { index: 0, score: 0.3 }, { index: 1, score: 0.2 }], 2)).toEqual([1, 0]);
    expect(parseRerank({ nope: true }, 2)).toEqual([]);
  });

  it("reads robots.txt and keeps crawls in scope", () => {
    const r = parseRobots("User-agent: *\nDisallow: /admin\nDisallow: /*?q=\nAllow: /admin/help$\n\nUser-agent: other\nDisallow: /\nSitemap: https://x.example/s.xml\n");
    expect(r.sitemaps).toEqual(["https://x.example/s.xml"]);
    expect(robotsAllows(r, "/admin/users")).toBe(false);
    expect(robotsAllows(r, "/admin/help")).toBe(true);
    expect(robotsAllows(r, "/admin/help/x")).toBe(false);
    expect(robotsAllows(r, "/search?q=x")).toBe(false);
    expect(robotsAllows(r, "/docs")).toBe(true);
    // A group for our own agent replaces the * group.
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\nUser-agent: embed-assistant\nDisallow: /tmp"), "/docs")).toBe(true);
    expect(normalizeUrl("/a/b?utm_source=x&id=2#top", "https://x.example/c")).toBe("https://x.example/a/b?id=2");
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    const scope = crawlScope("https://x.example/help/start");
    expect(scope).toEqual({ origin: "https://x.example", prefix: "/help/" });
    expect(inScope("https://x.example/help/faq", scope)).toBe(true);
    expect(inScope("https://x.example/blog", scope)).toBe(false);
    expect(inScope("https://y.example/help/faq", scope)).toBe(false);
    expect(inScope("https://x.example/help/logo.png", scope)).toBe(false);
  });

  it("parses llms.txt links", () => {
    const md = "# Docs\n\n> Summary\n\n## Guides\n\n- [Install](/docs/install.md): how to\n- [API](https://x.example/api.md \"API\")\n- [Mail](mailto:a@b.c)\n- [Install again](/docs/install.md#top)\n";
    expect(parseLlmsTxt(md, "https://x.example/llms.txt")).toEqual(["https://x.example/docs/install.md", "https://x.example/api.md"]);
  });
});

describe.skipIf(!DB)("knowledge sources (postgres)", () => {
  let sql: Sql;
  let s: Services;
  let app: ReturnType<typeof createApp>;
  let site: Server;
  let base: string;
  let adminKey: string;
  let tenantId: string;
  const reranked: { model: string; query: string; documents: string[]; top_n: number }[] = [];

  const admin = async (method: string, path: string, body?: unknown, status?: number) => {
    const r = await app.request(`/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (status !== undefined) expect(r.status, text).toBe(status);
    return text ? JSON.parse(text) : null;
  };

  beforeAll(async () => {
    site = createServer((rq, rs) => {
      const send = (type: string, body: string | Buffer) => rs.writeHead(200, { "content-type": type }).end(body);
      if (rq.url === "/llms.txt") return send("text/plain", "# Site\n\n- [Setup](/setup.md)\n- [Returns](/returns.pdf)\n- [Gone](/missing.md)\n");
      if (rq.url === "/rerank") {
        // Puts the documents that mention "store credit" first.
        let raw = "";
        rq.on("data", (c) => (raw += c));
        rq.on("end", () => {
          reranked.push(JSON.parse(raw));
          const { documents } = JSON.parse(raw) as { documents: string[] };
          send("application/json", JSON.stringify({ results: documents.map((d, index) => ({ index, relevance_score: d.includes("store credit") ? 1 : 0 })) }));
        });
        return;
      }
      const page = (title: string, body: string, head = "") =>
        send("text/html", `<!doctype html><html><head><title>${title} | Example Help</title>${head}</head><body><nav><a href="/help/">Help</a> <a href="/blog/">Blog</a></nav><main><h1>${title}</h1>${body}</main></body></html>`);
      if (rq.url === "/robots.txt") return send("text/plain", "User-agent: *\nDisallow: /help/private\n");
      if (rq.url === "/help/") return page("Help center", `<p>Start here for questions about orders.</p><a href="faq?utm_source=nav">FAQ</a> <a href="/help/hidden">Hidden</a> <a href="/help/private">Private</a> <a href="/help/nofollow-target" rel="nofollow">x</a> <a href="/help/logo.png">logo</a>`);
      if (rq.url === "/help/faq") return page("FAQ", `<p>Orders ship within two working days from our warehouse.</p><a href="/help/deep#a">Deep</a> <a href="/help/gone">Gone</a> <a href="/help/members">Members</a>`);
      if (rq.url === "/help/gone") return void rs.writeHead(404).end("not found");
      if (rq.url === "/help/members") return void rs.writeHead(403).end("sign in");
      if (rq.url === "/help/deep") return page("Deep page", "<p>Tracking numbers arrive by email once the parcel leaves.</p>");
      if (rq.url === "/help/hidden") return page("Hidden", "<p>This page asks search engines not to index it at all.</p><a href=\"/help/after-hidden\">next</a>", '<meta name="robots" content="noindex">');
      if (rq.url === "/help/after-hidden") return page("After hidden", "<p>Reached through a noindex page, which still passes on its links.</p>");
      if (rq.url?.startsWith("/help/") || rq.url?.startsWith("/blog/")) return page("Should not be crawled", "<p>This page is out of scope or disallowed for crawlers.</p>");
      if (rq.url === "/setup.md") return send("text/markdown", "# Setup guide\n\nInstall the agent with one command and restart.");
      if (rq.url === "/returns.pdf") return send("application/pdf", fixture("returns.pdf"));
      rs.writeHead(404).end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    sql = createSql(DB!, 5);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    const cfg = loadConfig({
      SECRET_KEY: "test-secret-key-0123456789abcdefghijkl",
      DATABASE_URL: DB,
      LOG_LEVEL: "silent",
      SERVE_WIDGET: "false",
      SERVE_CONSOLE: "false",
      INGEST_ALLOW_PRIVATE_NETWORKS: "true",
    });
    const models = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } });
    s = createServices(cfg, { sql, log: createLogger("silent"), models });
    app = createApp(s);
    tenantId = await createTenant(sql, "Knowledge");
    const k = generateAdminKey();
    await insertAdminKey(sql, tenantId, "test", k.hash, k.prefix);
    adminKey = k.key;
  });

  afterAll(async () => {
    site?.close();
    if (!sql) return;
    await s.executor.shutdown(1000);
    await sql.end({ timeout: 5 });
  });

  it("uploads files to a manual source", async () => {
    const src = await admin("POST", "/sources", { name: "Policies", type: "manual" }, 201);
    expect(src).toMatchObject({ maxPages: 200, syncIntervalHours: null });
    const form = new FormData();
    form.append("file", new File([fixture("returns.pdf")], "returns.pdf", { type: "application/pdf" }));
    form.append("file", new File([fixture("shipping.docx")], "shipping.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    form.append("file", new File(["# Contact\n\nWrite to help@shop.example."], "contact.md", { type: "text/markdown" }));
    form.append("file", new File([new Uint8Array([0, 1, 2, 255])], "logo.png", { type: "image/png" }));
    const upload = () => app.request(`/v1/admin/sources/${src.id}/files`, { method: "POST", headers: { authorization: `Bearer ${adminKey}` }, body: form });
    const res = await upload();
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results.map((r: { title: string | null }) => r.title)).toEqual(["Returns guide", "Shipping policy", "Contact", null]);
    expect(results[3].error).toMatch(/unsupported/);
    expect(results.slice(0, 3).every((r: { changed: boolean }) => r.changed)).toBe(true);
    // Same files again: no changes.
    const again = await (await upload()).json();
    expect(again.results.slice(0, 3).map((r: { changed: boolean }) => r.changed)).toEqual([false, false, false]);
    const docs = await admin("GET", `/sources/${src.id}/documents`, undefined, 200);
    expect(docs).toHaveLength(3);

    const crawled = await admin("POST", "/sources", { name: "Site", type: "url", url: `${base}/setup.md` }, 201);
    const refused = await app.request(`/v1/admin/sources/${crawled.id}/files`, { method: "POST", headers: { authorization: `Bearer ${adminKey}` }, body: form });
    expect(refused.status).toBe(400);
    const empty = await app.request(`/v1/admin/sources/${src.id}/files`, { method: "POST", headers: { authorization: `Bearer ${adminKey}` }, body: new FormData() });
    expect(empty.status).toBe(400);
  });

  it("reorders search results with a reranker, and falls back to the fused order", async () => {
    const src = await admin("POST", "/sources", { name: "Refunds", type: "manual" }, 201);
    await admin("PUT", `/sources/${src.id}/documents`, { title: "Refund policy", content: "# Refunds\n\nRefund requests are paid back to the card within 30 days." }, 200);
    await admin("PUT", `/sources/${src.id}/documents`, { title: "Gift cards", content: "# Gift cards\n\nA refund for a gift card purchase is given as store credit." }, 200);
    const p = { tenantId, sourceIds: [src.id], access: ["public"], query: "refund" };
    const fused = await retrieve(sql, { embeddings: null }, s.log, p);
    expect(fused.map((x) => x.title).sort()).toEqual(["Gift cards", "Refund policy"]);

    const withRerank = new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] }, rerank: { id: "r", baseUrl: base, model: "rr-1" } });
    const out = await retrieve(sql, withRerank, s.log, p);
    expect(out.map((x) => x.title)).toEqual(["Gift cards", "Refund policy"]);
    expect(out.map((x) => x.index)).toEqual([1, 2]);
    expect(reranked.at(-1)).toMatchObject({ model: "rr-1", query: "refund", top_n: 2 });
    expect(reranked.at(-1)!.documents[0]).toMatch(/^(Refund policy|Gift cards)\n/);

    const broken = { embeddings: null, reranker: { id: "x", model: "x", rerank: async () => Promise.reject(new Error("down")) } };
    expect((await retrieve(sql, broken, s.log, p)).map((x) => x.title)).toEqual(fused.map((x) => x.title));
  });

  it("re-tags passages when access changes", async () => {
    const [src] = (await admin("GET", "/sources")).filter((x: { name: string }) => x.name === "Policies");
    await admin("PATCH", `/sources/${src.id}`, { access: ["staff"], name: "Policies (internal)" }, 200);
    const tags = await sql<{ access: string[] }[]>`SELECT DISTINCT access FROM chunks WHERE source_id = ${src.id}`;
    expect(tags.map((t) => t.access)).toEqual([["staff"]]);
    const updated = await admin("GET", `/sources/${src.id}`);
    expect(updated).toMatchObject({ name: "Policies (internal)", access: ["staff"], syncIntervalHours: null });
    await admin("PATCH", `/sources/${src.id}`, { syncIntervalHours: 0 }, 400);
  });

  it("crawls llms.txt, including PDFs", async () => {
    const src = await admin("POST", "/sources", { name: "llms", type: "sitemap", url: `${base}/llms.txt`, syncIntervalHours: 24 }, 201);
    expect(src.syncIntervalHours).toBe(24);
    await ingestSource(s.ingest, tenantId, src.id);
    const after = await admin("GET", `/sources/${src.id}`);
    expect(after).toMatchObject({ status: "succeeded", documentCount: 2, lastError: "1 page(s) failed" });
    const titles = (await admin("GET", `/sources/${src.id}/documents`)).map((d: { title: string }) => d.title).sort();
    expect(titles).toEqual(["Returns guide", "Setup guide"]);
  });

  it("crawls a website by following links in scope", async () => {
    const src = await admin("POST", "/sources", { name: "Help site", type: "website", url: `${base}/help/` }, 201);
    expect(src.type).toBe("website");
    await ingestSource(s.ingest, tenantId, src.id);
    const after = await admin("GET", `/sources/${src.id}`);
    expect(after).toMatchObject({ status: "succeeded", lastError: null });
    const titles = (await admin("GET", `/sources/${src.id}/documents`)).map((d: { title: string }) => d.title).sort();
    // Not: /blog (out of scope), /help/private (robots.txt), the nofollow link, the image, the noindex page itself.
    expect(titles).toEqual(["After hidden", "Deep page", "FAQ", "Help center"]);
    await admin("POST", "/sources", { name: "No url", type: "website" }, 400);
  });

  it("embeds unchanged documents again when an embedding model is added or changed", async () => {
    const src = await admin("POST", "/sources", { name: "Re-embed", type: "manual" }, 201);
    const source = { id: src.id, tenant_id: tenantId, access: ["public"] };
    const doc = { externalId: "faq", title: "FAQ", url: null, content: "Parcels ship within two working days from the warehouse." };
    const fake = (model: string) => ({ id: "fake", model, embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) });
    const models = async (id: string) => (await sql<{ m: string | null }[]>`SELECT DISTINCT embedding_model AS m FROM chunks WHERE document_id = ${id}`).map((r) => r.m);
    const first = await upsertDocument({ ...s.ingest, embeddings: null }, source, doc);
    expect(await models(first.id)).toEqual([null]);
    expect((await upsertDocument({ ...s.ingest, embeddings: null }, source, doc)).changed).toBe(false);
    expect((await upsertDocument({ ...s.ingest, embeddings: fake("a") }, source, doc)).changed).toBe(true);
    expect(await models(first.id)).toEqual(["a"]);
    expect((await upsertDocument({ ...s.ingest, embeddings: fake("a") }, source, doc)).changed).toBe(false);
    expect((await upsertDocument({ ...s.ingest, embeddings: fake("b") }, source, doc)).changed).toBe(true);
    await admin("DELETE", `/sources/${src.id}`, undefined, 204);
  });

  it("schedules due re-syncs", async () => {
    await sql`UPDATE knowledge_sources SET updated_at = now() - interval '2 days' WHERE type <> 'manual'`;
    await sql`DELETE FROM jobs`;
    // Only the llms.txt source has an interval.
    expect(await scheduleDueSyncs(sql)).toBe(1);
    expect(await scheduleDueSyncs(sql)).toBe(0); // now queued
    const jobs = await sql<{ type: string }[]>`SELECT type FROM jobs`;
    expect(jobs).toEqual([{ type: "ingest_source" }]);
  });
});
