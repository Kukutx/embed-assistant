import { injectTraceHeaders } from "../lib/telemetry.js";
import { ModelError, isRetryableStatus } from "./types.js";

export interface Reranker {
  readonly id: string;
  readonly model: string;
  /** Indices of `documents`, most relevant first (at most `topN`). */
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<number[]>;
}

/**
 * A rerank endpoint in the common `POST {baseUrl}/rerank` shape
 * (`{model, query, documents, top_n}` -> `{results: [{index, relevance_score}]}`),
 * served by Cohere, Jina, vLLM, Infinity and others.
 */
export class HttpReranker implements Reranker {
  readonly id: string;
  readonly model: string;
  constructor(private readonly o: { id: string; baseUrl: string; model: string; apiKey?: string | undefined }) {
    this.id = o.id;
    this.model = o.model;
  }

  async rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<number[]> {
    if (!documents.length) return [];
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(3000),
      headers: {
        "content-type": "application/json",
        ...injectTraceHeaders({}),
        ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.o.model, query, documents, top_n: topN }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ModelError(`rerank ${res.status}: ${text.slice(0, 300)}`, isRetryableStatus(res.status), res.status);
    }
    return parseRerank(await res.json(), documents.length);
  }
}

/** Accepts `{results: [...]}`, `{data: [...]}` or a bare list, with `relevance_score` or `score`. */
export function parseRerank(json: unknown, count: number): number[] {
  const body = json as { results?: unknown; data?: unknown };
  const list = (Array.isArray(json) ? json : Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : []) as {
    index?: unknown;
    relevance_score?: unknown;
    score?: unknown;
  }[];
  const seen = new Set<number>();
  return list
    .map((r) => ({ index: Number(r?.index), score: Number(r?.relevance_score ?? r?.score ?? 0) }))
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < count && !seen.has(r.index) && seen.add(r.index))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.index);
}
