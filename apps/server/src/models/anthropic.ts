import Anthropic from "@anthropic-ai/sdk";
import type { ChatChunk, ChatModel, ChatRequest, ChatTurn } from "./types.js";
import { ModelError, isRetryableStatus } from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  id: string;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  effort?: Effort;
  /** Server-side refusal fallback (supported on the current Opus/Sonnet/Fable models). */
  serverFallback?: boolean;
}

/** Models that accept the server-side `fallbacks: "default"` parameter. */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5-2)$/;

/** Claude via the official Anthropic SDK (Messages API, streaming). */
export class AnthropicChat implements ChatModel {
  readonly provider = "anthropic";
  readonly id: string;
  readonly model: string;
  private client: Anthropic | null = null;

  constructor(private readonly o: AnthropicOptions) {
    this.id = o.id;
    this.model = o.model;
  }

  available(): boolean {
    return Boolean(this.o.apiKey);
  }

  private getClient(): Anthropic {
    // maxRetries 0: the router owns retries and failover across deployments.
    this.client ??= new Anthropic({ apiKey: this.o.apiKey, baseURL: this.o.baseUrl ?? null, maxRetries: 0, timeout: 120_000 });
    return this.client;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const useFallback = (this.o.serverFallback ?? true) && FALLBACK_MODELS.test(this.o.model);
    let stream;
    try {
      stream = this.getClient().beta.messages.stream(
        {
          model: this.o.model,
          max_tokens: req.maxOutputTokens,
          // Stable instructions first and marked cacheable; sources travel in the user turn.
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: toAnthropicMessages(req.messages),
          ...(req.tools?.length
            ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as never })) }
            : {}),
          output_config: { effort: this.o.effort ?? "low" },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw toModelError(err);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;
    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens =
              (event.message.usage.input_tokens ?? 0) +
              (event.message.usage.cache_read_input_tokens ?? 0) +
              (event.message.usage.cache_creation_input_tokens ?? 0);
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
            break;
          case "message_delta":
            outputTokens = event.usage.output_tokens ?? outputTokens;
            stopReason = event.delta.stop_reason ?? stopReason;
            if (event.delta.stop_reason === "refusal") yield { type: "refusal" };
            break;
        }
      }
      if (stopReason === "tool_use") {
        // Tool calls come from the assembled message, so inputs are complete JSON.
        const final = await stream.finalMessage();
        yield { type: "raw", provider: this.provider, content: final.content };
        for (const block of final.content) {
          if (block.type === "tool_use") {
            const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
            yield { type: "tool_call", call: { id: block.id, name: block.name, input } };
          }
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw err;
      throw toModelError(err);
    }
    yield { type: "usage", inputTokens, outputTokens };
  }
}

/** Provider-neutral transcript -> Messages API. Tool results travel in user turns. */
export function toAnthropicMessages(turns: ChatTurn[]): { role: "user" | "assistant"; content: never }[] {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      if (t.raw?.provider === "anthropic") out.push({ role: "assistant", content: t.raw.content });
      else if (t.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: [
            ...(t.content ? [{ type: "text", text: t.content }] : []),
            ...t.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
          ],
        });
      } else out.push({ role: "assistant", content: t.content });
    } else {
      out.push({
        role: "user",
        content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.content || "(empty)", ...(r.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return out as { role: "user" | "assistant"; content: never }[];
}

function toModelError(err: unknown): ModelError {
  if (err instanceof Anthropic.APIConnectionError) return new ModelError(`anthropic connection: ${err.message}`, true);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new ModelError(`anthropic ${status}: ${err.message}`, status === 0 || isRetryableStatus(status), status);
  }
  return new ModelError(`anthropic: ${(err as Error)?.message ?? String(err)}`, false);
}
