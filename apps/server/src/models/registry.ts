import { recordError, SpanKind, tracer } from "../lib/telemetry.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ModelAliasInfo } from "@embed-assistant/protocol";
import type { Config } from "../config.js";
import { AnthropicChat } from "./anthropic.js";
import { ExtractiveChat } from "./extractive.js";
import { OpenAICompatibleChat, OpenAICompatibleEmbeddings } from "./openaiCompatible.js";
import { HttpReranker, type Reranker } from "./rerank.js";
import type { ChatChunk, ChatModel, ChatRequest, EmbeddingModel } from "./types.js";
import { ModelError } from "./types.js";

/**
 * models.json — the only place that names vendors. Assistants reference aliases.
 * `${ENV_VAR}` inside string values is substituted from the environment.
 */
const DeploymentSchema = z.discriminatedUnion("provider", [
  z.object({
    id: z.string(),
    provider: z.literal("anthropic"),
    model: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    serverFallback: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    provider: z.literal("openai-compatible"),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    requiresKey: z.boolean().default(true),
    /** The model accepts images. Without it, attached images are replaced by a short note. */
    vision: z.boolean().default(false),
  }),
  z.object({ id: z.string(), provider: z.literal("builtin-extractive") }),
]);

const ModelsFileSchema = z.object({
  deployments: z.array(DeploymentSchema).min(1),
  /** alias -> ordered deployment ids (first available wins; later ones are failover). */
  aliases: z.record(z.string(), z.array(z.string()).min(1)),
  embeddings: z
    .object({
      id: z.string().default("embeddings"),
      baseUrl: z.string(),
      model: z.string(),
      apiKey: z.string().optional(),
      /** Texts per request (default 64). */
      batchSize: z.number().int().min(1).max(2048).optional(),
    })
    .optional(),
  /** Optional reranker (`POST {baseUrl}/rerank`), applied to the fused search results. */
  rerank: z
    .object({ id: z.string().default("rerank"), baseUrl: z.string(), model: z.string(), apiKey: z.string().optional() })
    .optional(),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)])) as T;
  }
  return value;
}

/** Defaults derived from env vars: every provider with credentials, then the offline fallback. */
export function defaultModelsFile(cfg: Config): ModelsFile {
  const deployments: ModelsFile["deployments"] = [];
  const standard: string[] = [];
  const fast: string[] = [];
  if (cfg.ANTHROPIC_API_KEY) {
    deployments.push(
      { id: "anthropic", provider: "anthropic", model: cfg.ANTHROPIC_MODEL, apiKey: cfg.ANTHROPIC_API_KEY, effort: cfg.ANTHROPIC_EFFORT },
      { id: "anthropic-fast", provider: "anthropic", model: cfg.ANTHROPIC_FAST_MODEL, apiKey: cfg.ANTHROPIC_API_KEY, effort: cfg.ANTHROPIC_EFFORT },
    );
    standard.push("anthropic");
    fast.push("anthropic-fast");
  }
  if (cfg.OPENAI_API_KEY) {
    deployments.push({
      id: "openai",
      provider: "openai-compatible",
      model: cfg.OPENAI_MODEL,
      baseUrl: cfg.OPENAI_BASE_URL,
      apiKey: cfg.OPENAI_API_KEY,
      requiresKey: true,
      vision: cfg.OPENAI_VISION,
    });
    standard.push("openai");
    fast.push("openai");
  }
  if (cfg.OLLAMA_BASE_URL) {
    deployments.push({
      id: "ollama",
      provider: "openai-compatible",
      model: cfg.OLLAMA_MODEL,
      baseUrl: `${cfg.OLLAMA_BASE_URL.replace(/\/$/, "")}/v1`,
      requiresKey: false,
      vision: cfg.OLLAMA_VISION,
    });
    standard.push("ollama");
    fast.push("ollama");
  }
  deployments.push({ id: "extractive", provider: "builtin-extractive" });
  standard.push("extractive");
  fast.push("extractive");
  const file: ModelsFile = { deployments, aliases: { standard, fast, private: cfg.OLLAMA_BASE_URL ? ["ollama"] : ["extractive"] } };
  if (cfg.EMBEDDINGS_BASE_URL && cfg.EMBEDDINGS_MODEL) {
    file.embeddings = {
      id: "embeddings",
      baseUrl: cfg.EMBEDDINGS_BASE_URL,
      model: cfg.EMBEDDINGS_MODEL,
      apiKey: cfg.EMBEDDINGS_API_KEY,
      ...(cfg.EMBEDDINGS_BATCH_SIZE ? { batchSize: cfg.EMBEDDINGS_BATCH_SIZE } : {}),
    };
  }
  if (cfg.RERANK_BASE_URL && cfg.RERANK_MODEL) {
    file.rerank = { id: "rerank", baseUrl: cfg.RERANK_BASE_URL, model: cfg.RERANK_MODEL, apiKey: cfg.RERANK_API_KEY };
  }
  return file;
}

export function loadModelsFile(cfg: Config, env: NodeJS.ProcessEnv = process.env): ModelsFile {
  if (!cfg.MODELS_CONFIG) return defaultModelsFile(cfg);
  const raw = JSON.parse(readFileSync(cfg.MODELS_CONFIG, "utf8")) as unknown;
  return ModelsFileSchema.parse(substituteEnv(raw, env));
}

export interface RoutedChunk {
  deploymentId: string;
  chunk: ChatChunk;
}

export class ModelRegistry {
  private readonly deployments = new Map<string, ChatModel>();
  readonly embeddings: EmbeddingModel | null;
  readonly reranker: Reranker | null;

  constructor(
    private readonly file: ModelsFile,
    private readonly onFailover?: (from: string, err: ModelError) => void,
  ) {
    for (const d of file.deployments) {
      if (this.deployments.has(d.id)) throw new Error(`duplicate deployment id ${d.id}`);
      this.deployments.set(d.id, buildDeployment(d));
    }
    for (const [alias, ids] of Object.entries(file.aliases)) {
      for (const id of ids) if (!this.deployments.has(id)) throw new Error(`alias ${alias} references unknown deployment ${id}`);
    }
    const e = file.embeddings;
    this.embeddings = e ? new OpenAICompatibleEmbeddings({ id: e.id, baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey, batchSize: e.batchSize }) : null;
    const r = file.rerank;
    this.reranker = r ? new HttpReranker({ id: r.id, baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey }) : null;
  }

  /** Register or replace a deployment programmatically (tests, plugins). */
  register(model: ChatModel, aliases: string[] = []): void {
    this.deployments.set(model.id, model);
    for (const a of aliases) this.file.aliases[a] = [model.id, ...(this.file.aliases[a] ?? []).filter((x) => x !== model.id)];
  }

  hasAlias(alias: string): boolean {
    return alias in this.file.aliases;
  }

  describe(): ModelAliasInfo[] {
    return Object.entries(this.file.aliases).map(([alias, ids]) => ({
      alias,
      deployments: ids.map((id) => {
        const d = this.deployments.get(id)!;
        return { id, provider: d.provider, model: d.model, available: d.available(), vision: d.vision === true };
      }),
    }));
  }

  /** The deployment that would serve the alias first, or null. */
  firstAvailable(alias: string): ChatModel | null {
    const ids = this.file.aliases[alias] ?? this.file.aliases.standard ?? [];
    for (const id of ids) {
      const d = this.deployments.get(id);
      if (d?.available()) return d;
    }
    return null;
  }

  /** True when the alias is served by a real language model (not the offline quoting mode). */
  hasLanguageModel(alias: string): boolean {
    const d = this.firstAvailable(alias);
    return !!d && d.provider !== "builtin";
  }

  /** True when the deployment that would serve the alias first can see images. */
  supportsVision(alias: string): boolean {
    return this.firstAvailable(alias)?.vision === true;
  }

  /**
   * Small non-streaming helper for auxiliary tasks (query rewriting, suggestions,
   * summaries). Returns null when no language model serves the alias or the call fails.
   */
  async complete(
    alias: string,
    p: { system: string; prompt: string; maxOutputTokens?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string | null> {
    if (!this.hasLanguageModel(alias)) return null;
    const signal = AbortSignal.any([AbortSignal.timeout(p.timeoutMs ?? 8000), ...(p.signal ? [p.signal] : [])]);
    let text = "";
    try {
      for await (const { chunk } of this.stream(alias, {
        system: p.system,
        messages: [{ role: "user", content: p.prompt }],
        question: p.prompt,
        sources: [],
        maxOutputTokens: p.maxOutputTokens ?? 400,
        signal,
      }, { languageOnly: true })) {
        if (chunk.type === "text") text += chunk.text;
      }
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Stream from the first available deployment of the alias. On a retryable
   * error BEFORE any text was produced, fail over to the next deployment.
   * After text has streamed we never splice another model's answer in.
   */
  async *stream(alias: string, req: ChatRequest, opts: { languageOnly?: boolean } = {}): AsyncGenerator<RoutedChunk> {
    const ids = this.file.aliases[alias] ?? this.file.aliases.standard;
    if (!ids) throw new ModelError(`unknown model alias ${alias}`, false);
    const candidates = ids
      .map((id) => this.deployments.get(id)!)
      .filter((d) => d.available() && !(opts.languageOnly && d.provider === "builtin"));
    if (candidates.length === 0) throw new ModelError(`no available deployment for alias ${alias}`, false);
    let lastErr: ModelError | null = null;
    for (const d of candidates) {
      let emitted = false;
      // GenAI semantic conventions; prompts and completions are never recorded.
      const span = tracer.startSpan(`chat ${d.model}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": d.provider,
          "gen_ai.request.model": d.model,
          "gen_ai.request.max_tokens": req.maxOutputTokens,
          "embed_assistant.deployment": d.id,
          "embed_assistant.model_alias": alias,
          ...(req.tools?.length ? { "embed_assistant.tool_count": req.tools.length } : {}),
        },
      });
      let finish = "stop";
      try {
        for await (const chunk of d.stream(d.vision ? req : withoutImages(req))) {
          if (chunk.type === "text" || chunk.type === "tool_call") emitted = true;
          if (chunk.type === "tool_call") finish = "tool_calls";
          if (chunk.type === "refusal") finish = "content_filter";
          if (chunk.type === "usage") {
            span.setAttribute("gen_ai.usage.input_tokens", chunk.inputTokens);
            span.setAttribute("gen_ai.usage.output_tokens", chunk.outputTokens);
          }
          yield { deploymentId: d.id, chunk };
        }
        span.setAttribute("gen_ai.response.finish_reasons", [finish]);
        return;
      } catch (err) {
        recordError(span, err);
        if (req.signal.aborted) throw err;
        const me = err instanceof ModelError ? err : new ModelError((err as Error).message, false);
        if (emitted || !me.retryable) throw me;
        lastErr = me;
        this.onFailover?.(d.id, me);
      } finally {
        // Also runs when the consumer stops iterating early.
        span.end();
      }
    }
    throw lastErr ?? new ModelError("all deployments failed", true);
  }
}

/** For models that cannot see images: drop them and say so, so the model does not pretend it saw them. */
export function withoutImages(req: ChatRequest): ChatRequest {
  if (!req.messages.some((m) => m.role === "user" && m.images?.length)) return req;
  return {
    ...req,
    messages: req.messages.map((m) => {
      if (m.role !== "user" || !m.images?.length) return m;
      const n = m.images.length;
      return { role: "user", content: `${m.content}\n\n[The user attached ${n === 1 ? "an image" : `${n} images`}, but you cannot see images. If it matters, ask them to describe it in words.]` };
    }),
  };
}

function buildDeployment(d: ModelsFile["deployments"][number]): ChatModel {
  switch (d.provider) {
    case "anthropic":
      return new AnthropicChat({
        id: d.id,
        model: d.model,
        apiKey: d.apiKey || undefined,
        baseUrl: d.baseUrl || undefined,
        effort: d.effort ?? "low",
        serverFallback: d.serverFallback ?? true,
      });
    case "openai-compatible":
      return new OpenAICompatibleChat({
        id: d.id,
        model: d.model,
        baseUrl: d.baseUrl,
        apiKey: d.apiKey || undefined,
        requiresKey: d.requiresKey,
        vision: d.vision,
      });
    case "builtin-extractive":
      return new ExtractiveChat(d.id);
  }
}
