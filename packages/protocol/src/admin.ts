/**
 * Admin API (`/v1/admin/*`). Authenticated with a tenant admin API key:
 * `Authorization: Bearer ea_admin_...`. Never called from host pages.
 */
import { z } from "zod";

const Id = z.string().min(1).max(64);
const Timestamp = z.string();

export const AccessTag = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** Absolute http(s) URL. Other schemes (javascript:, data:, file:) are rejected everywhere. */
export const HttpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/i, "must be an http(s) URL");

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
    /** sitemap only: maximum pages to fetch. */
    maxPages: z.number().int().min(1).max(5000).default(200),
  })
  .refine((v) => v.type === "manual" || v.url !== null, {
    message: "url is required for url and sitemap sources",
    path: ["url"],
  });
export type KnowledgeSourceInput = z.infer<typeof KnowledgeSourceInput>;

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
