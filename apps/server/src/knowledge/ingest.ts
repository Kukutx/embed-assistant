import { emitWebhook } from "../webhooks/webhooks.js";
import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import { dueSources, getSource, setSourceStatus, type SourceRow } from "../db/store.js";
import { enqueueJob } from "./jobs.js";
import { sha256Hex } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import type { EmbeddingModel } from "../models/types.js";
import { chunkText } from "./chunk.js";
import { extractDocument, parseLlmsTxt, UnsupportedDocumentError } from "./extract.js";
import { crawl, crawlScope, fetchRobots, inScope, normalizeUrl, robotsAllows } from "./crawl.js";
import { parseSitemap } from "./html.js";
import { safeFetch } from "./safeFetch.js";
import { toSearchText } from "./tokenize.js";

export interface IngestDeps {
  sql: Sql;
  log: Logger;
  embeddings: EmbeddingModel | null;
  allowPrivate: boolean;
}

export interface DocumentPayload {
  externalId: string;
  title: string;
  url: string | null;
  content: string;
}

const MAX_HNSW_DIM = 2000;
const CRAWL_ACCEPT = "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5";
const indexedDims = new Set<number>();

/**
 * Insert or replace one document and its chunks. Unchanged content (same hash)
 * is a no-op, so re-crawls are cheap. Returns the document id.
 */
export async function upsertDocument(
  deps: IngestDeps,
  source: Pick<SourceRow, "id" | "tenant_id" | "access">,
  doc: DocumentPayload,
): Promise<{ id: string; changed: boolean }> {
  const { sql } = deps;
  const hash = sha256Hex(`${doc.title}\n${doc.url ?? ""}\n${doc.content}`);
  const existing = await sql<{ id: string; content_hash: string }[]>`
    SELECT id, content_hash FROM documents WHERE source_id = ${source.id} AND external_id = ${doc.externalId}`;
  if (existing[0]?.content_hash === hash) {
    await sql`UPDATE documents SET updated_at = now() WHERE id = ${existing[0].id}`;
    return { id: existing[0].id, changed: false };
  }

  const chunks = chunkText(doc.content, doc.title);
  let vectors: number[][] | null = null;
  if (deps.embeddings && chunks.length) {
    try {
      vectors = await deps.embeddings.embed(chunks.map((c) => `${c.heading ?? doc.title}\n${c.content}`));
    } catch (err) {
      // Keyword search still works; log and continue rather than failing the document.
      deps.log.warn({ err, doc: doc.externalId }, "embedding failed; storing chunks without vectors");
    }
  }
  const dim = vectors?.[0]?.length ?? null;
  if (dim && dim <= MAX_HNSW_DIM && !indexedDims.has(dim)) {
    // One partial HNSW index per embedding dimension (models can change without a migration).
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS chunks_embedding_${dim} ON chunks USING hnsw ((embedding::vector(${dim})) vector_cosine_ops) WHERE embedding_dim = ${dim}`,
    );
    indexedDims.add(dim);
  }

  return sql.begin(async (tx) => {
    let id = existing[0]?.id;
    if (id) {
      await tx`UPDATE documents SET title = ${doc.title}, url = ${doc.url}, content_hash = ${hash}, updated_at = now() WHERE id = ${id}`;
      await tx`DELETE FROM chunks WHERE document_id = ${id}`;
    } else {
      id = newId("doc");
      await tx`
        INSERT INTO documents (id, tenant_id, source_id, external_id, title, url, content_hash)
        VALUES (${id}, ${source.tenant_id}, ${source.id}, ${doc.externalId}, ${doc.title}, ${doc.url}, ${hash})
        ON CONFLICT (source_id, external_id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url,
          content_hash = EXCLUDED.content_hash, updated_at = now()`;
    }
    const docId = id;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const vec = vectors?.[i];
      await tx`
        INSERT INTO chunks (id, tenant_id, source_id, document_id, ord, heading, content, search_text, access,
                            embedding, embedding_model, embedding_dim)
        VALUES (${newId("chk")}, ${source.tenant_id}, ${source.id}, ${docId}, ${i}, ${c.heading}, ${c.content},
                ${toSearchText(`${doc.title} ${c.heading ?? ""} ${c.content}`)}, ${source.access},
                ${vec ? `[${vec.join(",")}]` : null}::vector, ${vec ? deps.embeddings!.model : null}, ${vec ? vec.length : null})`;
    }
    return { id: docId, changed: true };
  });
}

/** Crawl a url, sitemap (or llms.txt) or website source. Documents not seen in a successful crawl are removed. */
/** A linked page that is gone (404, 410) or private (401, 403) is not part of the public site. */
const SKIPPABLE_STATUS = new Set([401, 403, 404, 410]);

export async function ingestSource(deps: IngestDeps, tenantId: string, sourceId: string): Promise<void> {
  const source = await getSource(deps.sql, tenantId, sourceId);
  if (!source) return;
  if (source.type === "manual") {
    await setSourceStatus(deps.sql, tenantId, sourceId, "succeeded");
    return;
  }
  await setSourceStatus(deps.sql, tenantId, sourceId, "running");
  const fetchOpts = { allowPrivate: deps.allowPrivate };
  try {
    const seen = new Set<string>();
    let failures = 0;
    let attempted = 0;
    /** Links found by a website crawl that are gone or need a sign-in: skipped, not failures. */
    let skipped = 0;
    const startUrl = source.type === "website" ? normalizeUrl(source.url!) : null;
    /** Fetch, extract and store one page; returns its links (for website crawls). */
    const visit = async (url: string): Promise<string[]> => {
      attempted++;
      try {
        const res = await safeFetch(url, { ...fetchOpts, maxBytes: 20 * 1024 * 1024, accept: CRAWL_ACCEPT });
        if (startUrl && url !== startUrl && SKIPPABLE_STATUS.has(res.status)) {
          skipped++;
          deps.log.info({ url, status: res.status }, "ingest: linked page skipped");
          return [];
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const page = await extractDocument(res.bytes, { contentType: res.contentType, name: res.url, baseUrl: res.url }).catch((err) => {
          if (err instanceof UnsupportedDocumentError) return null;
          throw err;
        });
        if (!page) return [];
        const externalId = page.canonical ?? res.url;
        if (!page.noindex && page.text.trim().length >= 20 && !seen.has(externalId)) {
          await upsertDocument(deps, source, { externalId, title: page.title, url: externalId, content: page.text });
          seen.add(externalId);
        }
        return page.links ?? [];
      } catch (err) {
        failures++;
        deps.log.warn({ url, err: (err as Error).message }, "ingest: page failed");
        return [];
      }
    };

    if (source.type === "website") {
      const scope = crawlScope(source.url!);
      const robots = await fetchRobots(scope.origin, fetchOpts);
      const allowed = (u: string) => inScope(u, scope) && robotsAllows(robots, new URL(u).pathname + new URL(u).search);
      // Pages listed in the site's sitemaps are crawled too (orphans that no link reaches).
      const fromSitemaps: string[] = [];
      for (const sm of robots.sitemaps.slice(0, 5)) {
        fromSitemaps.push(...(await collectSitemapUrls(sm, source.max_pages, fetchOpts).catch(() => [])));
      }
      await crawl([source.url!, ...fromSitemaps], { maxPages: source.max_pages, accept: (u) => u === normalizeUrl(source.url!) || allowed(u) }, visit);
    } else {
      let pages: string[];
      if (source.type === "url") {
        pages = [source.url!];
      } else if (/\/llms(-full)?\.txt$/i.test(new URL(source.url!).pathname)) {
        // llms.txt: a markdown index of the pages that matter, often with .md versions.
        const res = await safeFetch(source.url!, { ...fetchOpts, accept: "text/markdown,text/plain,*/*;q=0.5" });
        if (res.status >= 400) throw new Error(`llms.txt HTTP ${res.status}`);
        pages = parseLlmsTxt(res.body, res.url).slice(0, source.max_pages);
        if (pages.length === 0) throw new Error("llms.txt contained no links");
      } else {
        pages = await collectSitemapUrls(source.url!, source.max_pages, fetchOpts);
        if (pages.length === 0) throw new Error("sitemap contained no URLs");
      }
      const queue = [...pages];
      const worker = async () => {
        for (let url = queue.shift(); url; url = queue.shift()) await visit(url);
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    }

    if (seen.size === 0) throw new Error(`no pages could be ingested (${failures} failed)`);
    // Only prune when most pages succeeded, so a flaky crawl doesn't wipe the index.
    // Many sign-in walls at once look like a blocked crawler rather than private pages: keep the index then.
    if (failures <= attempted * 0.2 && skipped <= attempted * 0.5) {
      await deps.sql`DELETE FROM documents WHERE source_id = ${sourceId} AND NOT (external_id = ANY(${[...seen]}))`;
    }
    await setSourceStatus(deps.sql, tenantId, sourceId, "succeeded", failures ? `${failures} page(s) failed` : null);
    await emitWebhook(deps.sql, tenantId, "source.synced", { sourceId, status: "succeeded", pages: seen.size, failures, skipped }).catch(() => {});
  } catch (err) {
    await setSourceStatus(deps.sql, tenantId, sourceId, "failed", (err as Error).message.slice(0, 500));
    await emitWebhook(deps.sql, tenantId, "source.synced", { sourceId, status: "failed", error: (err as Error).message.slice(0, 500) }).catch(() => {});
    throw err;
  }
}

async function collectSitemapUrls(
  root: string,
  max: number,
  opts: { allowPrivate: boolean },
): Promise<string[]> {
  const urls: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length && urls.length < max && visited.size < 50) {
    const next = pending.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const res = await safeFetch(next, { ...opts, accept: "application/xml,text/xml,*/*;q=0.5" });
    if (res.status >= 400) throw new Error(`sitemap HTTP ${res.status}`);
    const parsed = parseSitemap(res.body);
    pending.push(...parsed.sitemaps);
    for (const u of parsed.urls) {
      if (urls.length >= max) break;
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

/** Queue a crawl for every source whose sync interval has elapsed. Returns how many were queued. */
export async function scheduleDueSyncs(sql: Sql): Promise<number> {
  const due = await dueSources(sql);
  for (const src of due) {
    await setSourceStatus(sql, src.tenant_id, src.id, "queued");
    await enqueueJob(sql, src.tenant_id, "ingest_source", { sourceId: src.id });
  }
  return due.length;
}
