/**
 * embed-assistant wire protocol, version 1.
 *
 * This module is the single source of truth for everything that crosses the
 * network between a host page, the widget and the server. The server validates
 * against these schemas, the widget imports the inferred types (type-only, so
 * zod never ships to browsers), and the OpenAPI document is generated from them.
 *
 * Compatibility rule for /v1: fields may be ADDED, never removed or retyped.
 * Clients must ignore unknown fields and unknown event types.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "1";
export const API_PREFIX = "/v1";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Server-generated identifiers are prefixed ULIDs, e.g. `conv_01J...`. */
export const Id = z.string().min(1).max(64);
export const Timestamp = z.string().describe("RFC 3339 timestamp");

export const ErrorBody = z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable code, e.g. `rate_limited`"),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ErrorCode = {
  BadRequest: "bad_request",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  RateLimited: "rate_limited",
  BudgetExceeded: "budget_exceeded",
  OriginNotAllowed: "origin_not_allowed",
  ModelUnavailable: "model_unavailable",
  Internal: "internal_error",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Widget bootstrap
// ---------------------------------------------------------------------------

export const ThemeMode = z.enum(["light", "dark", "auto"]);
export const Position = z.enum(["bottom-right", "bottom-left"]);

export const WidgetTheme = z.object({
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#2563eb"),
  mode: ThemeMode.default("auto"),
  position: Position.default("bottom-right"),
  radius: z.number().int().min(0).max(24).default(16),
});
export type WidgetTheme = z.infer<typeof WidgetTheme>;

/** Public, cacheable configuration a widget needs before the first message. */
export const PublicWidgetConfig = z.object({
  widgetId: Id,
  assistant: z.object({
    name: z.string(),
    greeting: z.string(),
    suggestions: z.array(z.string()).max(6),
    placeholder: z.string().nullable(),
    disclaimer: z.string().nullable(),
  }),
  theme: WidgetTheme,
  defaultLocale: z.string().nullable(),
  features: z.object({
    feedback: z.boolean(),
    sources: z.boolean(),
    history: z.boolean(),
  }),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type PublicWidgetConfig = z.infer<typeof PublicWidgetConfig>;

// ---------------------------------------------------------------------------
// Sessions (identity)
// ---------------------------------------------------------------------------

export const CreateSessionRequest = z.object({
  widgetId: Id,
  /**
   * Optional JWT signed by the HOST's backend with the widget's identity secret
   * (HS256). Claims: `sub` (required), `name`, `email`, `groups` (string[]),
   * `exp` (required, at most 1 hour ahead). Anything sent by the browser
   * without this signature is treated as anonymous.
   */
  userToken: z.string().max(4096).optional(),
  /**
   * Random id (at least 128 bits, base64url) the widget generated for an
   * anonymous visitor and keeps per browser. It is a bearer secret: whoever
   * holds it can read that visitor's conversations on this widget.
   */
  anonymousId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22,64}$/)
    .optional(),
  locale: z.string().max(35).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const Subject = z.object({
  id: z.string(),
  kind: z.enum(["anonymous", "user"]),
  name: z.string().nullable(),
});
export type Subject = z.infer<typeof Subject>;

export const Session = z.object({
  token: z.string().describe("Bearer token for the /v1 chat endpoints"),
  expiresAt: Timestamp,
  subject: Subject,
});
export type Session = z.infer<typeof Session>;

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const Citation = z.object({
  /** 1-based index used in the answer text as `[n]`. */
  index: z.number().int().min(1),
  documentId: Id,
  title: z.string(),
  url: z.string().nullable(),
  snippet: z.string(),
});
export type Citation = z.infer<typeof Citation>;

export const MessageRole = z.enum(["user", "assistant"]);
export const MessageStatus = z.enum(["streaming", "complete", "failed", "cancelled"]);
export const Feedback = z.enum(["up", "down"]);

export const Message = z.object({
  id: Id,
  conversationId: Id,
  role: MessageRole,
  /** Markdown subset (paragraphs, emphasis, code, lists, links, headings). */
  content: z.string(),
  citations: z.array(Citation),
  status: MessageStatus,
  feedback: Feedback.nullable(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const Conversation = z.object({
  id: Id,
  title: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Conversation = z.infer<typeof Conversation>;

export const CreateConversationRequest = z.object({
  title: z.string().max(200).optional(),
});

export const ConversationList = z.object({
  items: z.array(Conversation),
  nextCursor: z.string().nullable(),
});
export type ConversationList = z.infer<typeof ConversationList>;

export const MessageList = z.object({
  items: z.array(Message),
  nextCursor: z.string().nullable(),
});
export type MessageList = z.infer<typeof MessageList>;

/** Context the host page passes along (current page, product area...). */
export const PageContext = z
  .object({
    url: z.string().max(2048).optional(),
    title: z.string().max(300).optional(),
    locale: z.string().max(35).optional(),
    /** Free-form string key/values. Never trusted for authorization. */
    attributes: z.record(z.string().max(64), z.string().max(500)).optional(),
  })
  .refine((v) => Object.keys(v.attributes ?? {}).length <= 20, {
    message: "at most 20 attributes",
  });
export type PageContext = z.infer<typeof PageContext>;

export const CreateRunRequest = z.object({
  content: z.string().trim().min(1).max(4000),
  context: PageContext.optional(),
  /** Client-generated key; resubmitting the same key returns the same run. */
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const RunStatus = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: Id,
  conversationId: Id,
  status: RunStatus,
  createdAt: Timestamp,
});
export type Run = z.infer<typeof Run>;

export const CreateRunResponse = z.object({
  run: Run,
  userMessage: Message,
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const FeedbackRequest = z.object({
  rating: Feedback,
  comment: z.string().max(2000).optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;

// ---------------------------------------------------------------------------
// Run events (Server-Sent Events on GET /v1/runs/{id}/events)
//
// Each SSE frame: `id: <seq>`, `event: <type>`, `data: <RunEvent JSON>`.
// Reconnect with the `Last-Event-ID` header to resume after <seq>.
// The stream ends after a terminal event (run.completed/failed/cancelled).
// ---------------------------------------------------------------------------

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

const base = { seq: z.number().int().positive(), runId: Id, ts: Timestamp };

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.started"), data: z.object({ modelAlias: z.string() }) }),
  z.object({
    ...base,
    type: z.literal("retrieval.completed"),
    data: z.object({ sources: z.array(Citation) }),
  }),
  z.object({
    ...base,
    type: z.literal("message.started"),
    data: z.object({ messageId: Id }),
  }),
  z.object({
    ...base,
    type: z.literal("message.delta"),
    data: z.object({ messageId: Id, text: z.string() }),
  }),
  z.object({
    ...base,
    type: z.literal("message.completed"),
    data: z.object({ message: Message }),
  }),
  z.object({
    ...base,
    type: z.literal("run.completed"),
    data: z.object({ usage: Usage.nullable() }),
  }),
  z.object({
    ...base,
    type: z.literal("run.failed"),
    data: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({ ...base, type: z.literal("run.cancelled"), data: z.object({}) }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

export const TERMINAL_EVENTS: ReadonlySet<RunEventType> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENTS.has(type as RunEventType);
}

// ---------------------------------------------------------------------------
// Host -> assistant identity token (documented here so every language can sign it)
// ---------------------------------------------------------------------------

export const UserTokenClaims = z.object({
  sub: z.string().min(1).max(256),
  exp: z.number().int(),
  iat: z.number().int().optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  /** Knowledge access groups this user may read, in addition to `public` and `users`. */
  groups: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(50).optional(),
});
export type UserTokenClaims = z.infer<typeof UserTokenClaims>;

/** Access tags every session gets, by kind. Documents are filtered by tag overlap. */
export const ACCESS_PUBLIC = "public";
export const ACCESS_USERS = "users";

export * from "./admin.js";
