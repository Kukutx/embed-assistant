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
import { detectKind, extractDocument, parseLlmsTxt } from "../src/knowledge/extract.js";
import { ingestSource, scheduleDueSyncs } from "../src/knowledge/ingest.js";
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
