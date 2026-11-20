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
/** How answers sound. Applied as rules in the system prompt, on top of the instructions. */
export const AnswerStyle = z.object({
  tone: z.enum(["neutral", "friendly", "formal"]).default("neutral"),
  /** short: a few sentences; medium: complete but compact; detailed: thorough, with steps and examples. */
  length: z.enum(["short", "medium", "detailed"]).default("medium"),
});
export type AnswerStyle = z.infer<typeof AnswerStyle>;
export const DEFAULT_STYLE: AnswerStyle = { tone: "neutral", length: "medium" };

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

export const DEFAULT_REFUSAL_MESSAGE = "Sorry, I can't help with that. Is there something else I can help you with?";
export const DEFAULT_SUPPORT_MESSAGE =
  "It sounds like you may be going through a hard time. You don't have to face it alone: please reach out to someone you trust, " +
  "or contact a local crisis line or emergency services if you are in danger.";

/**
 * Safety rules checked before (and while) the assistant answers. Blocked terms
 * are matched locally; topics, moderation and prompt-injection detection use a
 * classifier call on the `fast` model alias (falling back to the assistant's).
 * If the classifier is unavailable the message is allowed (fail open) and the
 * error is counted in metrics.
 */
export const GuardrailConfig = z.object({
  /** Words or phrases (case-insensitive, whole words; substrings for CJK/Thai) that block a question. */
  blockedTerms: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
  /** Topics in plain language, e.g. "medical diagnosis" or "competitor products". Questions mainly about one are refused. */
  blockedTopics: z.array(z.string().trim().min(3).max(200)).max(30).default([]),
  /** Refuse harmful requests (violence, weapons, self-harm, sexual content, hate, illegal activity). */
  moderation: z.boolean().default(false),
  /** Refuse attempts to override the instructions, change the assistant's role or extract its prompt. */
  promptInjection: z.boolean().default(false),
  /** Also check answers: an answer containing a blocked term is replaced by the refusal message. */
  checkAnswers: z.boolean().default(true),
  /** Shown instead of an answer when a rule blocks the question. */
  refusalMessage: z.string().trim().min(1).max(1000).default(DEFAULT_REFUSAL_MESSAGE),
  /** Shown instead of the refusal when moderation detects self-harm. */
  supportMessage: z.string().trim().min(1).max(1000).default(DEFAULT_SUPPORT_MESSAGE),
});
export type GuardrailConfig = z.infer<typeof GuardrailConfig>;
export const DEFAULT_GUARDRAILS: GuardrailConfig = GuardrailConfig.parse({});

/** Which rule stopped an answer. */
export const GuardrailKind = z.enum(["term", "topic", "harmful", "injection", "answer_term"]);
export type GuardrailKind = z.infer<typeof GuardrailKind>;

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
  guardrails: GuardrailConfig,
  /**
   * Remember facts that signed-in users share (preferences, the product they use) across
   * conversations. Users see and erase them in the widget; never applies to anonymous visitors.
   */
  memory: z.boolean(),
  /** Playbooks (step-by-step procedures) the assistant follows when a request matches one. */
  playbookIds: z.array(Id),
  style: AnswerStyle,
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
  guardrails: GuardrailConfig,
  memory: z.boolean(),
  playbookIds: z.array(Id).max(50),
  style: AnswerStyle,
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
  guardrails: GuardrailConfig.default(DEFAULT_GUARDRAILS),
  memory: AssistantFields.memory.default(false),
  playbookIds: AssistantFields.playbookIds.default([]),
  style: AnswerStyle.default(DEFAULT_STYLE),
  changeNote: z.string().trim().max(300).optional(),
});
export type AssistantInput = z.infer<typeof AssistantInput>;
/** PATCH body: only the fields present are changed (no defaults are applied). */
export const AssistantPatch = z.object(AssistantFields).partial().extend({
  /** Why it changed; kept in the version history. */
  changeNote: z.string().trim().max(300).optional(),
});

/** An assistant's configuration as stored in its version history. */
export const AssistantConfig = z.object(AssistantFields);
export type AssistantConfig = z.infer<typeof AssistantConfig>;
export const AssistantVersion = z.object({
  version: z.number().int(),
  createdAt: Timestamp,
  /** Who saved it (key or person name); null for versions from before 1.0.9. */
  createdBy: z.string().nullable(),
  note: z.string().nullable(),
  /** Fields that differ from the previous version. */
  changes: z.array(z.string()),
});
export type AssistantVersion = z.infer<typeof AssistantVersion>;
export const AssistantVersionList = z.object({ items: z.array(AssistantVersion) });
export const AssistantVersionDetail = AssistantVersion.extend({ config: AssistantConfig });
export const RestoreVersionInput = z.object({ note: z.string().trim().max(300).optional() });

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
  features: z.object({
    feedback: z.boolean(),
    sources: z.boolean(),
    history: z.boolean(),
    /** Microphone button (the browser's speech recognition; some browsers send audio to their vendor's service). */
    voice: z.boolean(),
    /** Visitors can attach images (screenshots). Needs a model that can see images. */
    attachments: z.boolean(),
  }),
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
  voice: z.boolean().default(false),
  attachments: z.boolean().default(false),
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
  features: FeaturesInput.default({ feedback: true, sources: true, history: true, voice: false, attachments: false }),
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
    z.object({ id: z.string(), provider: z.string(), model: z.string(), available: z.boolean(), vision: z.boolean().optional() }),
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
  handoffReason: z.string().nullable().optional(),
  handoffResolvedAt: Timestamp.nullable().optional(),
  mode: z.enum(["assistant", "human"]).optional(),
  /** The person handling the conversation in `human` mode. */
  assignee: z.object({ id: Id.nullable(), name: z.string() }).nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AdminConversation = z.infer<typeof AdminConversation>;

/** Inbox filter: `waiting` = handoff requested, nobody has joined; `active` = a person is handling it; `resolved`. */
export const HandoffState = z.enum(["waiting", "active", "resolved", "any"]);
export const AssignRequest = z.object({
  /** Name shown to the visitor; defaults to the person's name (or the API key's name). */
  displayName: z.string().trim().min(1).max(80).optional(),
  /** Take over from another person. */
  force: z.boolean().default(false),
});
export const AgentReplyRequest = z.object({
  content: z.string().trim().min(1).max(8000),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export const ReleaseRequest = z.object({
  /** Mark the handoff as resolved (default) or put it back in the waiting queue. */
  resolve: z.boolean().default(true),
});

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
  /** Every audit log entry, for streaming to a SIEM. */
  "audit.recorded",
  /** The visitor wrote while a person handles the conversation (bridge to your helpdesk). */
  "message.received",
  /** A guardrail refused a question or replaced an answer. */
  "guardrail.triggered",
  /** The weekly insights digest (topics, resolution, suggested docs) is ready. */
  "insights.digest",
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
  /** Analyse the last 7 days every week and send the `insights.digest` webhook. */
  weeklyDigest: z.boolean(),
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
  /** Questions refused or answers replaced by guardrails, by rule. */
  guardrails: z.array(z.object({ kind: GuardrailKind, count: z.number().int() })),
  /**
   * Conversations the assistant resolved on its own: it answered, nobody asked for a person,
   * no answer was rated down and the last answer found knowledge. Absent before 1.0.12.
   */
  resolution: z
    .object({
      /** Conversations with at least one completed answer. */
      engaged: z.number().int(),
      resolved: z.number().int(),
      /** resolved / engaged (0..1), null without conversations. */
      rate: z.number().nullable(),
      handedOff: z.number().int(),
      downvoted: z.number().int(),
      /** The last answer found no knowledge. */
      noKnowledge: z.number().int(),
    })
    .optional(),
  /** Searches through POST /v1/search (no AI answer). Absent before 1.0.12. */
  searches: z
    .object({
      count: z.number().int(),
      withoutResults: z.number().int(),
      /** Search queries that found nothing, most frequent first. */
      gaps: z.array(CountedQuestion),
    })
    .optional(),
});
export type Insights = z.infer<typeof Insights>;

/** A group of similar visitor questions, with how well the assistant handled them. */
export const QuestionTopic = z.object({
  name: z.string(),
  /** Questions asked (repeats included). */
  questions: z.number().int(),
  conversations: z.number().int(),
  /** Questions that found no knowledge. */
  unanswered: z.number().int(),
  /** Answers rated not helpful. */
  downvoted: z.number().int(),
  /** Questions after which the visitor asked for a person. */
  handoffs: z.number().int(),
  /** Share of questions with any of the problems above (0..1). */
  problemRate: z.number(),
  /** The most frequent questions of the topic. */
  examples: z.array(z.string()),
  /** Existing documents closest to the topic. */
  relatedDocuments: z.array(z.object({ title: z.string(), url: z.string().nullable() })),
  /** For topics with problems, when a language model is available: the article to write or fix. */
  suggestion: z
    .object({
      action: z.enum(["write", "update"]),
      title: z.string(),
      outline: z.array(z.string()),
    })
    .nullable(),
});
export type QuestionTopic = z.infer<typeof QuestionTopic>;

export const TopicReport = z.object({
  id: Id,
  /** Only this assistant's conversations; null = all. */
  assistantId: Id.nullable(),
  days: z.number().int(),
  from: Timestamp,
  to: Timestamp,
  status: z.enum(["queued", "running", "completed", "failed"]),
  trigger: z.enum(["manual", "schedule"]),
  /** `model`: grouped by a language model; `keywords`: by shared words (no model available). */
  method: z.enum(["model", "keywords"]).nullable(),
  /** Distinct questions analysed (the most frequent, up to 300, are grouped by the model). */
  questionCount: z.number().int(),
  /** Most problems first. */
  topics: z.array(QuestionTopic),
  summary: z
    .object({
      conversations: z.number().int(),
      questions: z.number().int(),
      resolutionRate: z.number().nullable(),
      satisfaction: z.number().nullable(),
      handoffs: z.number().int(),
    })
    .nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type TopicReport = z.infer<typeof TopicReport>;
export const TopicReportRequest = z.object({
  days: z.number().int().min(1).max(90).default(30),
  assistantId: Id.optional(),
});

/** One entry of the tenant's audit log: a change made through the admin API (or a sensitive read such as an export). */
export const AuditEvent = z.object({
  id: Id,
  at: Timestamp,
  /** Who made the change. `api_key` today; console users come later. */
  actor: z.object({ type: z.enum(["api_key", "user", "system"]), id: z.string().nullable(), name: z.string().nullable() }),
  /** Dotted action name, e.g. `widgets.update`, `keys.create`, `sources.sync`. */
  action: z.string(),
  method: z.string(),
  /** Route template, e.g. `/v1/admin/widgets/{id}`. */
  route: z.string(),
  target: z.object({ type: z.string(), id: z.string().nullable() }),
  status: z.number().int(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  /** Request body with secret values redacted and long text shortened; null for file uploads and empty bodies. */
  changes: z.unknown().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
export const AuditEventList = z.object({ items: z.array(AuditEvent), nextCursor: z.string().nullable() });
export type AuditEventList = z.infer<typeof AuditEventList>;

// ---------------------------------------------------------------------------
// Console users, roles and single sign-on
// ---------------------------------------------------------------------------

/**
 * Roles, from most to least privileged:
 * - `owner`: everything, including managing other owners.
 * - `admin`: everything except managing owners.
 * - `editor`: maintain knowledge; read configuration, conversations and analytics.
 * - `analyst`: read configuration, conversations (and export them) and analytics.
 * - `agent`: read conversations and take over handed-off chats.
 */
export const Role = z.enum(["owner", "admin", "editor", "analyst", "agent"]);
export type Role = z.infer<typeof Role>;

export const Permission = z.enum([
  "config:read",
  "config:write",
  "knowledge:write",
  "conversations:read",
  "conversations:export",
  "conversations:reply",
  "conversations:delete",
  "analytics:read",
  "security:manage",
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: Permission.options,
  admin: Permission.options,
  editor: ["config:read", "knowledge:write", "conversations:read", "analytics:read"],
  analyst: ["config:read", "conversations:read", "conversations:export", "analytics:read"],
  agent: ["config:read", "conversations:read", "conversations:reply"],
};

const Email = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const ConsoleUser = z.object({
  id: Id,
  email: z.string(),
  name: z.string().nullable(),
  role: Role,
  disabled: z.boolean(),
  /** Has signed in at least once (otherwise the invitation is pending). */
  lastLoginAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ConsoleUser = z.infer<typeof ConsoleUser>;
export const ConsoleUserInput = z.object({
  email: Email,
  name: z.string().trim().min(1).max(200).nullable().default(null),
  role: Role,
});
export const ConsoleUserPatch = z.object({
  name: z.string().trim().min(1).max(200).nullable(),
  role: Role,
  disabled: z.boolean(),
}).partial();

/** Who is calling the admin API. */
export const Me = z.object({
  type: z.enum(["api_key", "user"]),
  id: Id,
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: Role,
  permissions: z.array(Permission),
  tenantId: Id,
});
export type Me = z.infer<typeof Me>;

/** OpenID Connect single sign-on for the console (one identity provider per tenant). */
export const SsoConfig = z.object({
  enabled: z.boolean(),
  /** Issuer URL, e.g. `https://login.microsoftonline.com/<tenant>/v2.0`, `https://accounts.google.com`, `https://<org>.okta.com`. */
  issuer: z.string(),
  clientId: z.string(),
  /** A client secret is stored (it is never returned). */
  hasClientSecret: z.boolean(),
  /** Only these e-mail domains may sign in; empty = any domain (invited users only, unless auto-provisioning). */
  allowedDomains: z.array(z.string()),
  /** Create users on first sign-in with this role; null = invited users only. */
  autoProvisionRole: Role.nullable(),
  /** Register this redirect URI with the identity provider. */
  redirectUri: z.string(),
  updatedAt: Timestamp.nullable(),
});
export type SsoConfig = z.infer<typeof SsoConfig>;
export const SsoConfigInput = z.object({
  enabled: z.boolean().default(true),
  issuer: HttpUrl,
  clientId: z.string().min(1).max(500),
  /** Omit to keep the stored secret. */
  clientSecret: z.string().min(1).max(2000).optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a domain like example.com")).max(50).default([]),
  autoProvisionRole: Role.exclude(["owner"]).nullable().default(null),
});

export const ConsoleLogin = z.object({ token: z.string(), expiresAt: Timestamp, user: ConsoleUser });

// ---------------------------------------------------------------------------
// Evaluations: test suites of questions with expectations, run against an
// assistant to measure answer quality and catch regressions.
// ---------------------------------------------------------------------------

/** What the assistant should do with a question. */
export const EvalOutcome = z.enum(["answer", "refuse", "handoff"]);
export type EvalOutcome = z.infer<typeof EvalOutcome>;

const Phrase = z.string().trim().min(1).max(300);
const EvalCaseFields = {
  question: z.string().trim().min(1).max(4000),
  /** Reference answer. When set, a model judges the answer against it (correctness and completeness, 1-5). */
  expectedAnswer: z.string().trim().min(1).max(8000).nullable(),
  /** Phrases the answer must contain (case-insensitive). */
  mustInclude: z.array(Phrase).max(20),
  /** Phrases the answer must not contain. */
  mustNotInclude: z.array(Phrase).max(20),
  /** Each entry must match a cited source: its URL, document id, or part of its title. */
  expectedSources: z.array(z.string().trim().min(1).max(2048)).max(10),
  /** Expected behaviour; null = not checked. */
  expectedOutcome: EvalOutcome.nullable(),
  /** Access groups the simulated visitor has (besides `public`), for restricted knowledge. */
  access: z.array(AccessTag).max(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
  /** Earlier turns of the conversation, oldest first, to test follow-up questions (multi-turn cases). */
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) })).max(20),
};
export const EvalCaseInput = z.object({
  question: EvalCaseFields.question,
  expectedAnswer: EvalCaseFields.expectedAnswer.default(null),
  mustInclude: EvalCaseFields.mustInclude.default([]),
  mustNotInclude: EvalCaseFields.mustNotInclude.default([]),
  expectedSources: EvalCaseFields.expectedSources.default([]),
  expectedOutcome: EvalCaseFields.expectedOutcome.default(null),
  access: EvalCaseFields.access.default([]),
  tags: EvalCaseFields.tags.default([]),
  history: EvalCaseFields.history.default([]),
});
export type EvalCaseInput = z.infer<typeof EvalCaseInput>;
export const EvalCasePatch = z.object(EvalCaseFields).partial();
/** Add one case or many (import). */
export const EvalCasesInput = z.object({ cases: z.array(EvalCaseInput).min(1).max(500) });
export const EvalCase = z.object({ id: Id, ...EvalCaseFields, createdAt: Timestamp, updatedAt: Timestamp });
export type EvalCase = z.infer<typeof EvalCase>;
export const EvalCaseList = z.object({ items: z.array(EvalCase) });

export const EvalRunStatus = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export const EvalRun = z.object({
  id: Id,
  suiteId: Id,
  assistantId: Id,
  /** Assistant configuration version the run used. */
  assistantVersion: z.number().int(),
  /** True when the run was asked for that version explicitly (otherwise it used the current configuration). */
  pinnedVersion: z.boolean(),
  status: EvalRunStatus,
  total: z.number().int(),
  completed: z.number().int(),
  passed: z.number().int(),
  /** Mean case score, 0..1 (null until a case finishes). */
  score: z.number().nullable(),
  /** Whether reference answers were scored by a model judge. */
  judge: z.boolean(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  error: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type EvalRun = z.infer<typeof EvalRun>;
export const EvalRunList = z.object({ items: z.array(EvalRun) });
export const EvalRunInput = z.object({
  /** Run the suite against another assistant (e.g. a copy with new instructions) to compare. Default: the suite's assistant. */
  assistantId: Id.optional(),
  /** Run against a saved version of the assistant from its history instead of the current configuration. */
  version: z.number().int().positive().optional(),
  /** Score reference answers with a model judge (uses model tokens). */
  judge: z.boolean().default(true),
});

export const EvalCheck = z.object({
  name: z.enum(["must_include", "must_not_include", "sources", "outcome", "judge"]),
  passed: z.boolean(),
  /** 0..1 */
  score: z.number(),
  detail: z.string().nullable(),
});
export const EvalResult = z.object({
  caseId: Id,
  question: z.string(),
  answer: z.string(),
  citations: z.array(z.object({ index: z.number().int(), title: z.string(), url: z.string().nullable(), documentId: z.string() })),
  outcome: EvalOutcome,
  guardrail: GuardrailKind.nullable(),
  passed: z.boolean(),
  score: z.number(),
  checks: z.array(EvalCheck),
  latencyMs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  error: z.string().nullable(),
  /** The same case in the previous completed run of this suite, for regressions. */
  previous: z.object({ passed: z.boolean(), score: z.number() }).nullable(),
});
export type EvalResult = z.infer<typeof EvalResult>;
export const EvalRunDetail = EvalRun.extend({ previousRunId: Id.nullable(), results: z.array(EvalResult) });
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;

export const EvalSuite = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  assistantId: Id,
  caseCount: z.number().int(),
  lastRun: EvalRun.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type EvalSuite = z.infer<typeof EvalSuite>;
export const EvalSuiteList = z.object({ items: z.array(EvalSuite) });
export const EvalSuiteInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  assistantId: Id,
});
export const EvalSuitePatch = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000),
  assistantId: Id,
}).partial();

// ---------------------------------------------------------------------------
// Platform API (`/v1/platform/*`): operators of a multi-tenant installation
// create, suspend and delete tenants. Authenticated with PLATFORM_ADMIN_TOKEN.
// ---------------------------------------------------------------------------

export const TenantStatus = z.enum(["active", "suspended"]);
export const Tenant = z.object({
  id: Id,
  name: z.string(),
  /** Your own identifier for this tenant (customer or billing account id). Unique. */
  externalId: z.string().nullable(),
  status: TenantStatus,
  /** Free-form labels for your own systems (plan, region…). */
  metadata: z.record(z.string(), z.string()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  suspendedAt: Timestamp.nullable(),
  /** Usage over the last 30 days. */
  usage: z.object({ conversations: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int() }),
});
export type Tenant = z.infer<typeof Tenant>;
export const TenantList = z.object({ items: z.array(Tenant), nextCursor: z.string().nullable() });
const Metadata = z.record(z.string().regex(/^[\w.-]{1,64}$/, "letters, digits, _ . -"), z.string().max(500)).refine((m) => Object.keys(m).length <= 30, "at most 30 keys");
export const TenantInput = z.object({
  name: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(200).nullable().default(null),
  metadata: Metadata.default({}),
  /** Name of the first admin API key, returned once in the response. */
  adminKeyName: z.string().trim().min(1).max(100).default("bootstrap"),
});
export const TenantPatch = z.object({
  name: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(200).nullable(),
  metadata: Metadata,
  /** Suspended tenants' widgets, admin API, console and MCP endpoint stop working; their data is kept. */
  status: TenantStatus,
}).partial();
export const CreatedTenant = z.object({ tenant: Tenant, adminKey: z.string() });
export const PlatformKeyInput = z.object({ name: z.string().trim().min(1).max(100).default("break-glass") });

/** What happened while one answer was produced, for debugging in the console. */
export const RunTrace = z.object({
  runId: Id,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  questionMessageId: Id,
  answerMessageId: Id.nullable(),
  modelAlias: z.string(),
  deploymentId: z.string().nullable(),
  assistantVersion: z.number().int(),
  createdAt: Timestamp,
  durationMs: z.number().int().nullable(),
  firstTokenMs: z.number().int().nullable(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  retrievalQuery: z.string().nullable(),
  /** Passages given to the model (after extra searches, the final set). */
  sources: z.array(z.object({ index: z.number().int(), documentId: z.string(), title: z.string(), url: z.string().nullable(), snippet: z.string() })),
  tools: z.array(z.object({
    callId: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    /** Asked the visitor first (confirmation) or ran in the page (client). */
    kind: z.enum(["server", "confirmation", "client"]),
    startedMs: z.number().int(),
    durationMs: z.number().int().nullable(),
    isError: z.boolean().nullable(),
  })),
  handoff: z.boolean(),
  guardrail: z.object({ kind: GuardrailKind, detail: z.string().nullable() }).nullable(),
  error: z.object({ code: z.string(), message: z.string().nullable() }).nullable(),
  /** Every event except text deltas, with its time from the start of the run. */
  timeline: z.array(z.object({ seq: z.number().int(), type: z.string(), atMs: z.number().int() })),
  deltaCount: z.number().int(),
});
export type RunTrace = z.infer<typeof RunTrace>;
export const RunTraceList = z.object({ items: z.array(RunTrace) });

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

/**
 * A procedure written in plain language (refunds, onboarding, troubleshooting a device).
 * The model sees each playbook's name and description, and reads the steps only when a
 * request matches, so many playbooks cost little context.
 */
export const Playbook = z.object({
  id: Id,
  /** Identifier the model uses to open it, e.g. `refund_request`. */
  name: z.string(),
  title: z.string(),
  /** When to use it, for the model. Be specific. */
  description: z.string(),
  /** The steps, conditions and wording to follow. Markdown. May refer to tools by name. */
  instructions: z.string(),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Playbook = z.infer<typeof Playbook>;
const PlaybookFields = {
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/, "lowercase letters, digits, _ and -, starting with a letter"),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(10).max(1000),
  instructions: z.string().trim().min(1).max(20000),
  enabled: z.boolean(),
};
export const PlaybookInput = z.object({ ...PlaybookFields, enabled: PlaybookFields.enabled.default(true) });
export type PlaybookInput = z.infer<typeof PlaybookInput>;
export const PlaybookPatch = z.object(PlaybookFields).partial();
