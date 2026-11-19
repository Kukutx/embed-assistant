import type { ChatChunk, ChatModel, ChatRequest, ChatTurn, EmbeddingModel } from "./types.js";
import { ModelError, isRetryableStatus } from "./types.js";
import { readSseData } from "./sse.js";
import { injectTraceHeaders } from "../lib/telemetry.js";

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Some servers (e.g. Ollama) need no key; mark them always available. */
  requiresKey: boolean;
  timeoutMs?: number;
}

/**
 * Chat Completions protocol: covers OpenAI and every compatible server
 * (Ollama, vLLM, LM Studio, Mistral, DeepSeek, gateways such as LiteLLM).
 */
export class OpenAICompatibleChat implements ChatModel {
  readonly provider = "openai-compatible";
  readonly id: string;
  readonly model: string;
  constructor(private readonly o: OpenAICompatibleOptions) {
    this.id = o.id;
    this.model = o.model;
  }

  available(): boolean {
    return !this.o.requiresKey || Boolean(this.o.apiKey);
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(this.o.timeoutMs ?? 120_000)]);
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...injectTraceHeaders({}),
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.o.model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: req.maxOutputTokens,
          messages: [{ role: "system", content: req.system }, ...toOpenAIMessages(req.messages)],
          ...(req.tools?.length
            ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
            : {}),
        }),
      });
    } catch (err) {
      if (req.signal.aborted) throw err;
      throw new ModelError(`connection failed: ${(err as Error).message}`, true);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new ModelError(`upstream ${res.status}: ${text.slice(0, 300)}`, isRetryableStatus(res.status), res.status);
    }
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of readSseData(res.body)) {
      if (data === "[DONE]") break;
      let parsed: {
        choices?: {
          delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) yield { type: "text", text: delta };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }
      if (choice?.finish_reason === "content_filter") yield { type: "refusal" };
      if (parsed.usage) {
        yield {
          type: "usage",
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
    }
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue;
      let input: Record<string, unknown> = {};
      try {
        const v = c.args.trim() ? (JSON.parse(c.args) as unknown) : {};
        if (v && typeof v === "object" && !Array.isArray(v)) input = v as Record<string, unknown>;
      } catch {
        input = { __invalid_json: c.args.slice(0, 2000) };
      }
      yield { type: "tool_call", call: { id: c.id || `call_${i}`, name: c.name, input } };
    }
  }
}

/** Provider-neutral transcript -> Chat Completions messages. */
export function toOpenAIMessages(turns: ChatTurn[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      out.push({
        role: "assistant",
        content: t.content || (t.toolCalls?.length ? null : ""),
        ...(t.toolCalls?.length
          ? { tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else {
      for (const r of t.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `Error: ${r.content}` : r.content || "(empty)" });
    }
  }
  return out;
}

export class OpenAICompatibleEmbeddings implements EmbeddingModel {
  readonly id: string;
  readonly model: string;
  constructor(private readonly o: Omit<OpenAICompatibleOptions, "requiresKey">) {
    this.id = o.id;
    this.model = o.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
        headers: {
          "content-type": "application/json",
          ...injectTraceHeaders({}),
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.o.model, input: batch }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ModelError(`embeddings ${res.status}: ${text.slice(0, 300)}`, isRetryableStatus(res.status), res.status);
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) out.push(d.embedding);
    }
    return out;
  }
}
