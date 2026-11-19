export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

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
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "refusal" };

export interface ChatModel {
  /** Deployment id, unique in the registry. */
  readonly id: string;
  readonly provider: string;
  readonly model: string;
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
