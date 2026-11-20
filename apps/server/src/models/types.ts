/** Plain text turn (stored conversation history). */
export interface TextTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** A tool the model may call (JSON Schema input). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** An image the user attached (only on the current question). */
export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64, no data: prefix. */
  data: string;
}

/**
 * One turn of the provider-neutral transcript. Assistant turns produced in this
 * run may carry the provider's raw content (`raw`), which the same provider
 * replays verbatim (e.g. reasoning blocks that must accompany tool calls).
 */
export type ChatTurn =
  | { role: "user"; content: string; images?: ImageInput[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: { provider: string; content: unknown } }
  | { role: "tool"; results: ToolResult[] };

/** A retrieved passage, numbered as the model should cite it ([1], [2], ...). */
export interface SourcePassage {
  index: number;
  documentId: string;
  title: string;
  url: string | null;
  heading: string | null;
  content: string;
}

export interface ChatRequest {
  /** Stable instructions (cacheable). */
  system: string;
  /** Conversation so far, ending with the user's question (sources already inlined by the prompt builder). */
  messages: ChatTurn[];
  /** The raw question and sources, for providers that do not call an LLM (extractive). */
  question: string;
  sources: SourcePassage[];
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Tools the model may call. Providers without tool support ignore them. */
  tools?: ToolDef[];
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "refusal" }
  | { type: "tool_call"; call: ToolCall }
  /** Provider-specific assistant content to replay on the next step of a tool loop. */
  | { type: "raw"; provider: string; content: unknown };

export interface ChatModel {
  /** Deployment id, unique in the registry. */
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  /** Accepts images in user turns. The router strips them (with a note) for models that do not. */
  readonly vision?: boolean;
  /** False when credentials are missing; the router skips it. */
  available(): boolean;
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface EmbeddingModel {
  readonly id: string;
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Provider failure. `retryable` errors may fail over to the next deployment if no text was emitted yet. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export const isRetryableStatus = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;
