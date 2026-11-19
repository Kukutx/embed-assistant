/**
 * Admin API (`/v1/admin/*`). Authenticated with a tenant admin API key:
 * `Authorization: Bearer ea_admin_...`. Never called from host pages.
 */
import { z } from "zod";
import { ToolName, ToolParameters } from "./tools.js";

const Id = z.string().min(1).max(64);
const Timestamp = z.string();

export const AccessTag = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** Absolute http(s) URL. Other schemes (javascript:, data:, file:) are rejected everywhere. */
export const HttpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/i, "must be an http(s) URL");

export const DEFAULT_HANDOFF_MESSAGE =
  "I've passed this conversation to our team. Someone will get back to you as soon as possible.";

/** "Talk to a person". The handoff itself is delivered through the `handoff.requested` webhook. */
export const HandoffConfig = z.object({
  enabled: z.boolean(),
  /** Shown to the visitor after a handoff. */
  message: z.string().min(1).max(1000),
  /** Optional contact page, ticket form or chat link offered with the message. */
  url: HttpUrl.nullable(),
  /** Label of the handoff button in the widget (default: localized "Talk to a person"). */
  label: z.string().max(60).nullable(),
});
export type HandoffConfig = z.infer<typeof HandoffConfig>;

export const Assistant = z.object({
  id: Id,
  name: z.string(),
  instructions: z.string(),
  modelAlias: z.string(),
  greeting: z.string(),
  suggestions: z.array(z.string()),
  placeholder: z.string().nullable(),
  disclaimer: z.string().nullable(),
  /** Knowledge sources this assistant may search. Empty = none (pure chat). */
  sourceIds: z.array(Id),
  /** Answer only from retrieved sources; say so when nothing relevant is found. */
  groundedOnly: z.boolean(),
  /** HTTP actions (tools) this assistant may call. */
  actionIds: z.array(Id),
  /** Remote MCP servers whose tools this assistant may call. */
  mcpServerIds: z.array(Id),
  handoff: HandoffConfig,
  /** Offer follow-up question suggestions after each answer. */
  followUps: z.boolean(),
  /** Rewrite follow-up questions into standalone search queries (uses the `fast` model alias). */
  queryRewrite: z.boolean(),
  /** Let the model run extra knowledge searches with its own queries. */
  agenticSearch: z.boolean(),
  /** Accept tools registered by the host page (`EmbedAssistant.registerTool`). */
  clientTools: z.boolean(),
  /** Mask e-mail addresses, phone numbers, card numbers and IBANs before storing or sending to a model. */
  redactPii: z.boolean(),
  version: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Assistant = z.infer<typeof Assistant>;

/** Field rules without defaults; Input adds defaults, Patch makes everything optional. */
const AssistantFields = {
  name: z.string().min(1).max(100),
  instructions: z.string().max(20000),
  modelAlias: z.string().min(1).max(64),
  greeting: z.string().max(500),
  suggestions: z.array(z.string().min(1).max(120)).max(6),
  placeholder: z.string().max(120).nullable(),
  disclaimer: z.string().max(300).nullable(),
  sourceIds: z.array(Id).max(100),
  groundedOnly: z.boolean(),
  actionIds: z.array(Id).max(50),
  mcpServerIds: z.array(Id).max(20),
  handoff: HandoffConfig,
  followUps: z.boolean(),
  queryRewrite: z.boolean(),
  agenticSearch: z.boolean(),
  clientTools: z.boolean(),
  redactPii: z.boolean(),
};

export const AssistantInput = z.object({
  name: AssistantFields.name,
  instructions: AssistantFields.instructions.default(""),
  modelAlias: AssistantFields.modelAlias.default("standard"),
  greeting: AssistantFields.greeting.default("Hi! How can I help you today?"),
  suggestions: AssistantFields.suggestions.default([]),
  placeholder: AssistantFields.placeholder.default(null),
  disclaimer: AssistantFields.disclaimer.default(null),
  sourceIds: AssistantFields.sourceIds.default([]),
  groundedOnly: AssistantFields.groundedOnly.default(true),
  actionIds: AssistantFields.actionIds.default([]),
  mcpServerIds: AssistantFields.mcpServerIds.default([]),
  handoff: HandoffConfig.default({ enabled: false, message: DEFAULT_HANDOFF_MESSAGE, url: null, label: null }),
  followUps: AssistantFields.followUps.default(true),
  queryRewrite: AssistantFields.queryRewrite.default(true),
  agenticSearch: AssistantFields.agenticSearch.default(true),
  clientTools: AssistantFields.clientTools.default(true),
  redactPii: AssistantFields.redactPii.default(false),
});
export type AssistantInput = z.infer<typeof AssistantInput>;
/** PATCH body: only the fields present are changed (no defaults are applied). */
export const AssistantPatch = z.object(AssistantFields).partial();

export const Origin = z
  .string()
  .regex(/^(https?:\/\/[^/\s]+|\*)$/, "an origin like https://example.com, or *");

export const Widget = z.object({
  id: Id,
  assistantId: Id,
  name: z.string(),
  allowedOrigins: z.array(z.string()),
  theme: z.object({
    accentColor: z.string(),
    mode: z.enum(["light", "dark", "auto"]),
    position: z.enum(["bottom-right", "bottom-left"]),
    radius: z.number().int(),
  }),
  defaultLocale: z.string().nullable(),
  features: z.object({ feedback: z.boolean(), sources: z.boolean(), history: z.boolean() }),
  /** Daily cap of model tokens for this widget; null = tenant default. */
  dailyTokenBudget: z.number().int().positive().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Widget = z.infer<typeof Widget>;

const ThemeInput = z.object({
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#2563eb"),
  mode: z.enum(["light", "dark", "auto"]).default("auto"),
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  radius: z.number().int().min(0).max(24).default(16),
});
const FeaturesInput = z.object({
  feedback: z.boolean().default(true),
  sources: z.boolean().default(true),
  history: z.boolean().default(true),
});

const WidgetFields = {
  assistantId: Id,
  name: z.string().min(1).max(100),
  allowedOrigins: z.array(Origin).max(50),
  theme: ThemeInput,
  defaultLocale: z.string().max(35).nullable(),
  features: FeaturesInput,
  dailyTokenBudget: z.number().int().positive().nullable(),
};

export const WidgetInput = z.object({
  assistantId: WidgetFields.assistantId,
  name: WidgetFields.name,
  allowedOrigins: WidgetFields.allowedOrigins.default([]),
  theme: ThemeInput.default({ accentColor: "#2563eb", mode: "auto", position: "bottom-right", radius: 16 }),
  defaultLocale: WidgetFields.defaultLocale.default(null),
  features: FeaturesInput.default({ feedback: true, sources: true, history: true }),
  dailyTokenBudget: WidgetFields.dailyTokenBudget.default(null),
});
export type WidgetInput = z.infer<typeof WidgetInput>;
/** PATCH body. `theme` and `features` are replaced as a whole (missing keys take their defaults). */
export const WidgetPatch = z.object(WidgetFields).partial();

/** Returned once on widget creation / secret rotation. Store it in the HOST backend only. */
export const WidgetSecret = z.object({ widgetId: Id, identitySecret: z.string() });

export const SourceType = z.enum(["url", "sitemap", "manual"]);
export const IngestStatus = z.enum(["idle", "queued", "running", "succeeded", "failed"]);

export const KnowledgeSource = z.object({
  id: Id,
  name: z.string(),
  type: SourceType,
  url: z.string().nullable(),
  access: z.array(AccessTag),
  status: IngestStatus,
  lastError: z.string().nullable(),
  documentCount: z.number().int(),
  /** Pages fetched at most per crawl (sitemap and llms.txt sources). */
  maxPages: z.number().int(),
  /** Re-crawl automatically every N hours; null = only on demand. */
  syncIntervalHours: z.number().int().nullable(),
  lastIngestedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeSourceInput = z
  .object({
    name: z.string().min(1).max(200),
    type: SourceType,
    url: HttpUrl.nullable().default(null),
    /** Who may see answers from this source: `public`, `users`, or a custom group. */
    access: z.array(AccessTag).min(1).max(20).default(["public"]),
    /** sitemap and llms.txt: maximum pages to fetch. */
    maxPages: z.number().int().min(1).max(5000).default(200),
    /** url, sitemap and llms.txt sources: re-crawl every N hours (null = only on demand). */
    syncIntervalHours: z.number().int().min(1).max(720).nullable().default(null),
  })
  .refine((v) => v.type === "manual" || v.url !== null, {
    message: "url is required for url and sitemap sources",
    path: ["url"],
  });
export type KnowledgeSourceInput = z.infer<typeof KnowledgeSourceInput>;

/** PATCH body for a source. Changing access re-tags every stored passage immediately. */
export const KnowledgeSourcePatch = z
  .object({
    name: z.string().min(1).max(200),
    url: HttpUrl,
    access: z.array(AccessTag).min(1).max(20),
    maxPages: z.number().int().min(1).max(5000),
    syncIntervalHours: z.number().int().min(1).max(720).nullable(),
  })
  .partial();
export type KnowledgeSourcePatch = z.infer<typeof KnowledgeSourcePatch>;

/** Result of uploading files to a source (one entry per file). */
export const FileUploadResult = z.object({
  results: z.array(
    z.object({
      name: z.string(),
      documentId: z.string().nullable(),
      title: z.string().nullable(),
      changed: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});

export const DocumentInput = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(2_000_000),
  url: HttpUrl.nullable().default(null),
  /** Stable key for upserts (defaults to url, then title). */
  externalId: z.string().max(512).optional(),
});
export type DocumentInput = z.infer<typeof DocumentInput>;

export const KnowledgeDocument = z.object({
  id: Id,
  sourceId: Id,
  title: z.string(),
  url: z.string().nullable(),
  chunkCount: z.number().int(),
  updatedAt: Timestamp,
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

export const ModelAliasInfo = z.object({
  alias: z.string(),
  deployments: z.array(
    z.object({ id: z.string(), provider: z.string(), model: z.string(), available: z.boolean() }),
  ),
});
export type ModelAliasInfo = z.infer<typeof ModelAliasInfo>;

export const AdminConversation = z.object({
  id: Id,
  assistantId: Id,
  widgetId: Id,
  subjectId: z.string(),
  subjectKind: z.enum(["anonymous", "user"]),
  title: z.string().nullable(),
  messageCount: z.number().int(),
  handoffRequestedAt: Timestamp.nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AdminConversation = z.infer<typeof AdminConversation>;

export const UsageSummary = z.object({
  from: Timestamp,
  to: Timestamp,
  runs: z.number().int(),
  failedRuns: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  feedbackUp: z.number().int(),
  feedbackDown: z.number().int(),
  p50FirstTokenMs: z.number().nullable(),
  p95FirstTokenMs: z.number().nullable(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

// ---------------------------------------------------------------------------
// Actions: HTTP endpoints the assistant can call as tools
// ---------------------------------------------------------------------------

export const ActionMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const Action = z.object({
  id: Id,
  /** Tool name the model sees, e.g. `get_order_status`. */
  name: ToolName,
  /** Human-readable label shown in the widget while it runs. */
  title: z.string(),
  /** When to use it, for the model. Be specific. */
  description: z.string(),
  /** JSON Schema (type object) of the arguments. */
  parameters: z.record(z.string(), z.unknown()),
  method: ActionMethod,
  /** `{name}` placeholders are filled from arguments (URL-encoded); other arguments go to the query (GET/DELETE) or JSON body. */
  url: z.string(),
  /** Header names configured (values are write-only and stored encrypted). */
  headerNames: z.array(z.string()),
  /** Ask the visitor to approve each call (use for anything that changes data). */
  confirm: z.boolean(),
  /** Only offer this action to signed-in users, and forward their identity in `EA-User-*` headers. */
  requireUser: z.boolean(),
  timeoutMs: z.number().int(),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Action = z.infer<typeof Action>;

const ActionFields = {
  name: ToolName,
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  parameters: ToolParameters,
  method: ActionMethod,
  url: HttpUrl,
  /** Extra request headers, e.g. `{ "Authorization": "Bearer ..." }`. Replaces all headers when present. */
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(4096)).refine((h) => Object.keys(h).length <= 20, "at most 20 headers"),
  confirm: z.boolean(),
  requireUser: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(30_000),
  enabled: z.boolean(),
};
export const ActionInput = z.object({
  name: ActionFields.name,
  title: ActionFields.title,
  description: ActionFields.description,
  parameters: ActionFields.parameters.default({ type: "object", properties: {} }),
  method: ActionFields.method.default("POST"),
  url: ActionFields.url,
  headers: ActionFields.headers.default({}),
  confirm: ActionFields.confirm.default(false),
  requireUser: ActionFields.requireUser.default(false),
  timeoutMs: ActionFields.timeoutMs.default(10_000),
  enabled: ActionFields.enabled.default(true),
});
export type ActionInput = z.infer<typeof ActionInput>;
export const ActionPatch = z.object(ActionFields).partial();

export const ActionTestRequest = z.object({ arguments: z.record(z.string(), z.unknown()).default({}) });
export const ActionTestResult = z.object({
  status: z.number().int(),
  isError: z.boolean(),
  output: z.string(),
  durationMs: z.number().int(),
});

// ---------------------------------------------------------------------------
// MCP servers: remote Model Context Protocol servers whose tools assistants can use
// ---------------------------------------------------------------------------

/** A tool advertised by a remote MCP server (cached at the last refresh). */
export const McpRemoteTool = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
});
export type McpRemoteTool = z.infer<typeof McpRemoteTool>;

export const McpServer = z.object({
  id: Id,
  /** Short slug; the model sees tools as `<name>__<tool>`. */
  name: z.string(),
  title: z.string(),
  /** Streamable HTTP endpoint. */
  url: z.string(),
  /** Header names configured (values are write-only and stored encrypted). */
  headerNames: z.array(z.string()),
  /** Ask the visitor before each call, except tools the server marks read-only. */
  confirm: z.boolean(),
  /** Only offer these tools to signed-in users. */
  requireUser: z.boolean(),
  /** Tool names to expose; null = all. */
  allowedTools: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  tools: z.array(McpRemoteTool),
  protocolVersion: z.string().nullable(),
  serverName: z.string().nullable(),
  lastError: z.string().nullable(),
  refreshedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;

const McpServerFields = {
  name: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "lowercase letters, digits and _, starting with a letter (max 24)"),
  title: z.string().min(1).max(100),
  url: HttpUrl,
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(4096)).refine((h) => Object.keys(h).length <= 20, "at most 20 headers"),
  confirm: z.boolean(),
  requireUser: z.boolean(),
  allowedTools: z.array(z.string().min(1).max(128)).max(200).nullable(),
  enabled: z.boolean(),
};
export const McpServerInput = z.object({
  name: McpServerFields.name,
  title: McpServerFields.title,
  url: McpServerFields.url,
  headers: McpServerFields.headers.default({}),
  confirm: McpServerFields.confirm.default(true),
  requireUser: McpServerFields.requireUser.default(false),
  allowedTools: McpServerFields.allowedTools.default(null),
  enabled: McpServerFields.enabled.default(true),
});
export type McpServerInput = z.infer<typeof McpServerInput>;
export const McpServerPatch = z.object(McpServerFields).partial();

// ---------------------------------------------------------------------------
// Webhooks (Standard Webhooks signatures: webhook-id / webhook-timestamp / webhook-signature)
// ---------------------------------------------------------------------------

export const WebhookEventType = z.enum([
  "conversation.created",
  "message.completed",
  "feedback.submitted",
  "handoff.requested",
  "source.synced",
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const Webhook = z.object({
  id: Id,
  url: z.string(),
  description: z.string(),
  events: z.array(WebhookEventType),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Webhook = z.infer<typeof Webhook>;

const WebhookFields = {
  url: HttpUrl,
  description: z.string().max(300),
  events: z.array(WebhookEventType).min(1),
  enabled: z.boolean(),
};
export const WebhookInput = z.object({
  url: WebhookFields.url,
  description: WebhookFields.description.default(""),
  events: WebhookFields.events,
  enabled: WebhookFields.enabled.default(true),
});
export type WebhookInput = z.infer<typeof WebhookInput>;
export const WebhookPatch = z.object(WebhookFields).partial();
/** Returned once on creation / rotation: verify deliveries with it. */
export const CreatedWebhook = z.object({ webhook: Webhook, secret: z.string() });

export const WebhookDelivery = z.object({
  id: Id,
  event: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** `admin`: full admin API. `mcp`: the MCP endpoint only (read knowledge, ask). */
export const ApiKeyScope = z.enum(["admin", "mcp"]);
export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiKeyScope),
  /** Knowledge access tags granted to `mcp` keys. */
  access: z.array(AccessTag),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;
export const ApiKeyInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScope).min(1).default(["admin"]),
  access: z.array(AccessTag).min(1).max(50).default(["public"]),
});
export const CreatedApiKey = z.object({ apiKey: ApiKey, key: z.string() });

// ---------------------------------------------------------------------------
// Tenant settings and insights
// ---------------------------------------------------------------------------

export const TenantSettings = z.object({
  /** Conversations untouched for this many days are deleted permanently. null = keep forever. */
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  /** Daily model-token budget shared by widgets without their own budget. null = server default. */
  dailyTokenBudget: z.number().int().positive().nullable(),
});
export type TenantSettings = z.infer<typeof TenantSettings>;
export const TenantSettingsPatch = TenantSettings.partial();

const CountedQuestion = z.object({ question: z.string(), count: z.number().int(), lastAskedAt: Timestamp });

export const Insights = z.object({
  from: Timestamp,
  to: Timestamp,
  conversations: z.number().int(),
  questions: z.number().int(),
  /** Questions where retrieval found no relevant knowledge. */
  unanswered: z.number().int(),
  handoffs: z.number().int(),
  feedbackUp: z.number().int(),
  feedbackDown: z.number().int(),
  /** Share of rated answers that were rated up (0..1), null without ratings. */
  satisfaction: z.number().nullable(),
  topQuestions: z.array(CountedQuestion),
  /** Questions without matching knowledge: write or fix these docs first. */
  knowledgeGaps: z.array(CountedQuestion),
  /** Answers rated down, most recent first. */
  downvoted: z.array(z.object({ conversationId: Id, messageId: Id, question: z.string(), answer: z.string(), comment: z.string().nullable(), createdAt: Timestamp })),
  tools: z.array(z.object({ name: z.string(), calls: z.number().int(), errors: z.number().int() })),
});
export type Insights = z.infer<typeof Insights>;
