import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import type { EmbeddingModel, SourcePassage } from "../models/types.js";
import { queryTokens, searchTokens, termMatches, toTsQuery } from "./tokenize.js";

export interface RetrieveParams {
  tenantId: string;
  sourceIds: string[];
  /** Access tags of the asking session; chunks must share at least one. */
  access: string[];
  query: string;
  limit?: number;
}

interface Candidate {
  id: string;
  document_id: string;
  title: string;
  url: string | null;
  heading: string | null;
  content: string;
}

const RRF_K = 60;
const PER_SOURCE_LIMIT = 24;
/** Keyword-only hits must cover at least this share of the query's distinct tokens. */
const MIN_KEYWORD_COVERAGE = 0.34;

/**
 * Hybrid retrieval: full-text (always) + vector similarity (when an embedding
 * model is configured), fused with Reciprocal Rank Fusion. Access filtering
 * happens inside the SQL, before ranking, so the model never sees forbidden text.
 */
export async function retrieve(
  sql: Sql,
  embeddings: EmbeddingModel | null,
  log: Logger,
  p: RetrieveParams,
): Promise<SourcePassage[]> {
  if (p.sourceIds.length === 0 || p.access.length === 0) return [];
  const limit = p.limit ?? 6;
  const tokens = queryTokens(p.query);
  const tsq = toTsQuery(tokens);

  const keywordP: Promise<Candidate[]> = tsq
    ? sql<Candidate[]>`
        SELECT c.id, c.document_id, d.title, d.url, c.heading, c.content
        FROM chunks c JOIN documents d ON d.id = c.document_id, to_tsquery('simple', ${tsq}) q
        WHERE c.tenant_id = ${p.tenantId} AND c.source_id = ANY(${sql.array(p.sourceIds)})
          AND c.access && ${sql.array(p.access)} AND c.tsv @@ q
        ORDER BY ts_rank_cd(c.tsv, q, 1) DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    : Promise.resolve([]);

  const vectorP: Promise<Candidate[]> = (async () => {
    if (!embeddings) return [];
    try {
      const [vec] = await embeddings.embed([p.query], AbortSignal.timeout(10_000));
      if (!vec?.length) return [];
      const dim = vec.length;
      const literal = `[${vec.join(",")}]`;
      return await sql<Candidate[]>`
        SELECT c.id, c.document_id, d.title, d.url, c.heading, c.content
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${p.tenantId} AND c.source_id = ANY(${sql.array(p.sourceIds)})
          AND c.access && ${sql.array(p.access)}
          AND c.embedding_dim = ${dim} AND c.embedding_model = ${embeddings.model}
        ORDER BY c.embedding::vector(${sql.unsafe(String(dim))}) <=> ${literal}::vector(${sql.unsafe(String(dim))})
        LIMIT ${PER_SOURCE_LIMIT}`;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "vector search failed; using keyword results only");
      return [];
    }
  })();

  const [keyword, vector] = await Promise.all([keywordP, vectorP]);

  const queryTokenSet = new Set(tokens);
  const scores = new Map<string, { c: Candidate; score: number }>();
  const add = (list: Candidate[], filter: (c: Candidate) => boolean) =>
    list.forEach((c, rank) => {
      if (!filter(c)) return;
      const prev = scores.get(c.id);
      scores.set(c.id, { c, score: (prev?.score ?? 0) + 1 / (RRF_K + rank + 1) });
    });
  add(vector, () => true);
  add(keyword, (c) => {
    if (vector.length) return true;
    // Without vectors, drop weak keyword matches (e.g. a single common word).
    if (queryTokenSet.size === 0) return false;
    const chunkTokens = new Set(searchTokens(`${c.title} ${c.heading ?? ""} ${c.content}`));
    let hit = 0;
    for (const t of queryTokenSet) if (termMatches(t, chunkTokens)) hit++;
    return hit / queryTokenSet.size >= MIN_KEYWORD_COVERAGE;
  });

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  const perDoc = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const { c } of ranked) {
    const n = perDoc.get(c.document_id) ?? 0;
    if (n >= 2) continue;
    perDoc.set(c.document_id, n + 1);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked.map((c, i) => ({
    index: i + 1,
    documentId: c.document_id,
    title: c.title,
    url: c.url,
    heading: c.heading,
    content: c.content,
  }));
}
