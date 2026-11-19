import { emitWebhook } from "../webhooks/webhooks.js";
import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import { getSource, setSourceStatus, type SourceRow } from "../db/store.js";
import { sha256Hex } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import type { EmbeddingModel } from "../models/types.js";
import { chunkText } from "./chunk.js";
import { extractPage, parseSitemap } from "./html.js";
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
                ${toSearchText(`${doc.title} ${c.heading ?? ""} ${c.content}`)}, ${tx.array(source.access)},
                ${vec ? `[${vec.join(",")}]` : null}::vector, ${vec ? deps.embeddings!.model : null}, ${vec ? vec.length : null})`;
    }
    return { id: docId, changed: true };
  });
}

/** Crawl a url/sitemap source. Documents not seen in a successful crawl are removed. */
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
    let pages: string[];
    if (source.type === "url") {
      pages = [source.url!];
    } else {
      pages = await collectSitemapUrls(source.url!, source.max_pages, fetchOpts);
      if (pages.length === 0) throw new Error("sitemap contained no URLs");
    }

    const seen = new Set<string>();
    let failures = 0;
    const queue = [...pages];
    const worker = async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const res = await safeFetch(url, fetchOpts);
          if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
          const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
          const page = isHtml
            ? extractPage(res.body, res.url)
            : { title: titleFromUrl(res.url), text: res.body, canonical: null };
          if (page.text.trim().length < 20) continue;
          const externalId = page.canonical ?? res.url;
          await upsertDocument(deps, source, { externalId, title: page.title, url: externalId, content: page.text });
          seen.add(externalId);
        } catch (err) {
          failures++;
          deps.log.warn({ url, err: (err as Error).message }, "ingest: page failed");
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    if (seen.size === 0) throw new Error(`no pages could be ingested (${failures} failed)`);
    // Only prune when most pages succeeded, so a flaky crawl doesn't wipe the index.
    if (failures <= pages.length * 0.2) {
      await deps.sql`DELETE FROM documents WHERE source_id = ${sourceId} AND NOT (external_id = ANY(${deps.sql.array([...seen])}))`;
    }
    await setSourceStatus(deps.sql, tenantId, sourceId, "succeeded", failures ? `${failures} page(s) failed` : null);
    await emitWebhook(deps.sql, tenantId, "source.synced", { sourceId, status: "succeeded", pages: seen.size, failures }).catch(() => {});
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

function titleFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\.\w+$/, "") : u.hostname;
}
