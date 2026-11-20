/**
 * Data access. Every function takes the tenant id explicitly and filters on it,
 * so a bug in a route cannot read across tenants by forgetting a WHERE clause.
 */
import type {
  Attachment,
  AdminConversation,
  Assistant,
  AssistantConfig,
  AssistantInput,
  Citation,
  Conversation,
  HandoffConfig,
  KnowledgeDocument,
  KnowledgeSource,
  Message,
  Widget,
  WidgetInput,
} from "@embed-assistant/protocol";
import { AnswerStyle, DEFAULT_GUARDRAILS, DEFAULT_STYLE, GuardrailConfig } from "@embed-assistant/protocol";
import { iso, isoOrNull } from "../lib/time.js";
import { newId } from "../lib/ids.js";
import type { Sql } from "./pool.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface AssistantRow {
  id: string;
  tenant_id: string;
  name: string;
  instructions: string;
  model_alias: string;
  greeting: string;
  suggestions: string[];
  placeholder: string | null;
  disclaimer: string | null;
  source_ids: string[];
  grounded_only: boolean;
  action_ids: string[];
  mcp_server_ids: string[];
  handoff: HandoffConfig;
  follow_ups: boolean;
  query_rewrite: boolean;
  agentic_search: boolean;
  client_tools: boolean;
  redact_pii: boolean;
  /** Stored partially; read through guardrailsOf() to apply defaults. */
  guardrails: Partial<GuardrailConfig> | null;
  memory: boolean;
  playbook_ids: string[];
  /** Stored partially; read through styleOf() to apply defaults. */
  style: Partial<AnswerStyle> | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Guardrail settings with defaults filled in (older rows store `{}`). */
export function styleOf(r: Pick<AssistantRow, "style">): AnswerStyle {
  const parsed = AnswerStyle.safeParse(r.style ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_STYLE };
}

export function guardrailsOf(r: Pick<AssistantRow, "guardrails">): GuardrailConfig {
  const parsed = GuardrailConfig.safeParse(r.guardrails ?? {});
  return parsed.success ? parsed.data : DEFAULT_GUARDRAILS;
}

export interface WidgetRow {
  id: string;
  tenant_id: string;
  assistant_id: string;
  name: string;
  allowed_origins: string[];
  theme: Widget["theme"];
  default_locale: string | null;
  features: Omit<Widget["features"], "voice" | "attachments"> & { voice?: boolean; attachments?: boolean };
  daily_token_budget: number | null;
  identity_secret: string;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationRow {
  id: string;
  tenant_id: string;
  assistant_id: string;
  widget_id: string;
  subject_id: string;
  subject_kind: "anonymous" | "user";
  title: string | null;
  handoff_at: Date | null;
  handoff_reason?: string | null;
  handoff_resolved_at?: Date | null;
  mode: "assistant" | "human";
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  status: Message["status"];
  feedback: "up" | "down" | null;
  suggestions: string[];
  tool_calls: { name: string; isError: boolean }[];
  author_name: string | null;
  attachments: Attachment[];
  created_at: Date;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  widget_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  model_alias: string;
  assistant_version: number;
  created_at: Date;
}

export interface SourceRow {
  id: string;
  tenant_id: string;
  name: string;
  type: "url" | "sitemap" | "manual";
  url: string | null;
  access: string[];
  max_pages: number;
  sync_interval_hours: number | null;
  status: KnowledgeSource["status"];
  last_error: string | null;
  last_ingested_at: Date | null;
  created_at: Date;
  document_count?: number;
}

// ---------------------------------------------------------------------------
// Mappers (row -> wire)
// ---------------------------------------------------------------------------

export const toAssistant = (r: AssistantRow): Assistant => ({
  id: r.id,
  name: r.name,
  instructions: r.instructions,
  modelAlias: r.model_alias,
  greeting: r.greeting,
  suggestions: r.suggestions,
  placeholder: r.placeholder,
  disclaimer: r.disclaimer,
  sourceIds: r.source_ids,
  groundedOnly: r.grounded_only,
  actionIds: r.action_ids,
  mcpServerIds: r.mcp_server_ids,
  handoff: r.handoff,
  followUps: r.follow_ups,
  queryRewrite: r.query_rewrite,
  agenticSearch: r.agentic_search,
  clientTools: r.client_tools,
  redactPii: r.redact_pii,
  guardrails: guardrailsOf(r),
  memory: r.memory,
  playbookIds: r.playbook_ids ?? [],
  style: styleOf(r),
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toWidget = (r: WidgetRow): Widget => ({
  id: r.id,
  assistantId: r.assistant_id,
  name: r.name,
  allowedOrigins: r.allowed_origins,
  theme: r.theme,
  defaultLocale: r.default_locale,
  features: { ...r.features, voice: r.features.voice ?? false, attachments: r.features.attachments ?? false },
  dailyTokenBudget: r.daily_token_budget,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  handoffRequestedAt: isoOrNull(r.handoff_at),
  mode: r.mode ?? "assistant",
  agentName: r.mode === "human" ? (r.assignee_name ?? null) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  citations: r.citations,
  status: r.status,
  feedback: r.feedback,
  ...(r.role === "assistant" ? { suggestions: r.suggestions ?? [], author: r.author_name ? { type: "human" as const, name: r.author_name } : null } : {}),
  ...(r.role === "user" && r.attachments?.length ? { attachments: r.attachments } : {}),
  createdAt: iso(r.created_at),
});

export const toSource = (r: SourceRow): KnowledgeSource => ({
  id: r.id,
  name: r.name,
  type: r.type,
  url: r.url,
  access: r.access,
  status: r.status,
  lastError: r.last_error,
  documentCount: Number(r.document_count ?? 0),
  maxPages: r.max_pages,
  syncIntervalHours: r.sync_interval_hours,
  lastIngestedAt: isoOrNull(r.last_ingested_at),
  createdAt: iso(r.created_at),
});

// ---------------------------------------------------------------------------
// Tenants and admin keys
// ---------------------------------------------------------------------------

export async function createTenant(sql: Tx, name: string): Promise<string> {
  const id = newId("ten");
  await sql`INSERT INTO tenants (id, name) VALUES (${id}, ${name})`;
  return id;
}

export async function insertAdminKey(
  sql: Tx,
  tenantId: string,
  name: string,
  hash: Buffer,
  prefix: string,
  scopes: string[] = ["admin"],
  access: string[] = ["public"],
) {
  const id = newId("key");
  await sql`INSERT INTO admin_keys (id, tenant_id, name, key_hash, prefix, scopes, access)
            VALUES (${id}, ${tenantId}, ${name}, ${hash}, ${prefix}, ${sql.array(scopes)}, ${sql.array(access)})`;
  return id;
}

export interface KeyRow {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  access: string[];
  created_at: Date;
  last_used_at: Date | null;
  /** Status of the key's tenant: a suspended tenant's keys are refused. */
  tenant_status?: "active" | "suspended";
}

export async function findAdminKey(sql: Tx, hash: Buffer): Promise<KeyRow | null> {
  // last_used_at is refreshed at most once a minute to avoid a write per request.
  const rows = await sql<KeyRow[]>`
    SELECT k.id, k.tenant_id, k.name, k.prefix, k.scopes, k.access, k.created_at, k.last_used_at, t.status AS tenant_status
    FROM admin_keys k JOIN tenants t ON t.id = k.tenant_id
    WHERE k.key_hash = ${hash} AND k.revoked_at IS NULL`;
  const row = rows[0];
  if (row && (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000)) {
    await sql`UPDATE admin_keys SET last_used_at = now() WHERE id = ${row.id}`;
  }
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Assistants
// ---------------------------------------------------------------------------

export async function listAssistants(sql: Tx, tenantId: string): Promise<AssistantRow[]> {
  return sql<AssistantRow[]>`SELECT * FROM assistants WHERE tenant_id = ${tenantId} ORDER BY created_at`;
}

export async function getAssistant(sql: Tx, tenantId: string, id: string): Promise<AssistantRow | null> {
  const rows = await sql<AssistantRow[]>`SELECT * FROM assistants WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

/** Who saved a configuration, and why (kept in the version history). */
export interface ChangeMeta {
  by?: string | null | undefined;
  note?: string | null | undefined;
}

/** The configurable part of an assistant (what the version history stores). */
export function assistantConfig(r: AssistantRow): AssistantConfig {
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...config } = toAssistant(r);
  return config;
}

async function recordVersion(sql: Tx, r: AssistantRow, meta: ChangeMeta): Promise<void> {
  await sql`
    INSERT INTO assistant_versions (assistant_id, tenant_id, version, config, created_by, note)
    VALUES (${r.id}, ${r.tenant_id}, ${r.version}, ${sql.json(assistantConfig(r) as never)}, ${meta.by ?? null}, ${meta.note ?? null})
    ON CONFLICT DO NOTHING`;
}

export async function createAssistant(sql: Tx, tenantId: string, input: AssistantInput, meta: ChangeMeta = {}): Promise<AssistantRow> {
  const id = newId("ast");
  const rows = await sql<AssistantRow[]>`
    INSERT INTO assistants (id, tenant_id, name, instructions, model_alias, greeting, suggestions,
                            placeholder, disclaimer, source_ids, grounded_only, action_ids, mcp_server_ids, handoff,
                            follow_ups, query_rewrite, agentic_search, client_tools, redact_pii, guardrails, memory, playbook_ids, style)
    VALUES (${id}, ${tenantId}, ${input.name}, ${input.instructions}, ${input.modelAlias}, ${input.greeting},
            ${sql.json(input.suggestions)}, ${input.placeholder}, ${input.disclaimer},
            ${sql.array(input.sourceIds)}, ${input.groundedOnly}, ${sql.array(input.actionIds)}, ${sql.array(input.mcpServerIds)},
            ${sql.json(input.handoff as never)}, ${input.followUps}, ${input.queryRewrite}, ${input.agenticSearch},
            ${input.clientTools}, ${input.redactPii}, ${sql.json(input.guardrails as never)}, ${input.memory},
            ${sql.array(input.playbookIds)}, ${sql.json(input.style as never)})
    RETURNING *`;
  await recordVersion(sql, rows[0]!, meta);
  return rows[0]!;
}

export async function updateAssistant(
  sql: Tx,
  tenantId: string,
  id: string,
  patch: Partial<AssistantInput>,
  meta: ChangeMeta = {},
): Promise<AssistantRow | null> {
  const current = await getAssistant(sql, tenantId, id);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    instructions: patch.instructions ?? current.instructions,
    modelAlias: patch.modelAlias ?? current.model_alias,
    greeting: patch.greeting ?? current.greeting,
    suggestions: patch.suggestions ?? current.suggestions,
    placeholder: patch.placeholder !== undefined ? patch.placeholder : current.placeholder,
    disclaimer: patch.disclaimer !== undefined ? patch.disclaimer : current.disclaimer,
    sourceIds: patch.sourceIds ?? current.source_ids,
    groundedOnly: patch.groundedOnly ?? current.grounded_only,
    actionIds: patch.actionIds ?? current.action_ids,
    mcpServerIds: patch.mcpServerIds ?? current.mcp_server_ids,
    handoff: patch.handoff ?? current.handoff,
    followUps: patch.followUps ?? current.follow_ups,
    queryRewrite: patch.queryRewrite ?? current.query_rewrite,
    agenticSearch: patch.agenticSearch ?? current.agentic_search,
    clientTools: patch.clientTools ?? current.client_tools,
    redactPii: patch.redactPii ?? current.redact_pii,
    guardrails: patch.guardrails ?? guardrailsOf(current),
    memory: patch.memory ?? current.memory,
    playbookIds: patch.playbookIds ?? current.playbook_ids,
    style: patch.style ?? styleOf(current),
  };
  const rows = await sql<AssistantRow[]>`
    UPDATE assistants SET
      name = ${next.name}, instructions = ${next.instructions}, model_alias = ${next.modelAlias},
      greeting = ${next.greeting}, suggestions = ${sql.json(next.suggestions)},
      placeholder = ${next.placeholder}, disclaimer = ${next.disclaimer},
      source_ids = ${sql.array(next.sourceIds)}, grounded_only = ${next.groundedOnly},
      action_ids = ${sql.array(next.actionIds)}, mcp_server_ids = ${sql.array(next.mcpServerIds)}, handoff = ${sql.json(next.handoff as never)},
      follow_ups = ${next.followUps}, query_rewrite = ${next.queryRewrite}, agentic_search = ${next.agenticSearch},
      client_tools = ${next.clientTools}, redact_pii = ${next.redactPii}, guardrails = ${sql.json(next.guardrails as never)}, memory = ${next.memory},
      playbook_ids = ${sql.array(next.playbookIds)}, style = ${sql.json(next.style as never)},
      version = version + 1, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  if (rows[0]) await recordVersion(sql, rows[0], meta);
  return rows[0] ?? null;
}

export async function deleteAssistant(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM assistants WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export async function listWidgets(sql: Tx, tenantId: string): Promise<WidgetRow[]> {
  return sql<WidgetRow[]>`SELECT * FROM widgets WHERE tenant_id = ${tenantId} ORDER BY created_at`;
}

/** Public lookup by id (widget ids are public identifiers). */
export async function getWidgetById(sql: Tx, id: string): Promise<WidgetRow | null> {
  // A suspended tenant's widgets behave as if they did not exist.
  const rows = await sql<WidgetRow[]>`
    SELECT w.* FROM widgets w JOIN tenants t ON t.id = w.tenant_id WHERE w.id = ${id} AND t.status = 'active'`;
  return rows[0] ?? null;
}

export async function getWidget(sql: Tx, tenantId: string, id: string): Promise<WidgetRow | null> {
  const rows = await sql<WidgetRow[]>`SELECT * FROM widgets WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

export async function createWidget(
  sql: Tx,
  tenantId: string,
  input: WidgetInput,
  encryptedSecret: string,
): Promise<WidgetRow> {
  const id = newId("wgt");
  const rows = await sql<WidgetRow[]>`
    INSERT INTO widgets (id, tenant_id, assistant_id, name, allowed_origins, theme, default_locale,
                         features, daily_token_budget, identity_secret)
    VALUES (${id}, ${tenantId}, ${input.assistantId}, ${input.name}, ${sql.array(input.allowedOrigins)},
            ${sql.json(input.theme)}, ${input.defaultLocale}, ${sql.json(input.features)},
            ${input.dailyTokenBudget}, ${encryptedSecret})
    RETURNING *`;
  return rows[0]!;
}

export async function updateWidget(
  sql: Tx,
  tenantId: string,
  id: string,
  patch: Partial<WidgetInput>,
): Promise<WidgetRow | null> {
  const c = await getWidget(sql, tenantId, id);
  if (!c) return null;
  const rows = await sql<WidgetRow[]>`
    UPDATE widgets SET
      assistant_id = ${patch.assistantId ?? c.assistant_id},
      name = ${patch.name ?? c.name},
      allowed_origins = ${sql.array(patch.allowedOrigins ?? c.allowed_origins)},
      theme = ${sql.json(patch.theme ?? c.theme)},
      default_locale = ${patch.defaultLocale !== undefined ? patch.defaultLocale : c.default_locale},
      features = ${sql.json(patch.features ?? c.features)},
      daily_token_budget = ${patch.dailyTokenBudget !== undefined ? patch.dailyTokenBudget : c.daily_token_budget},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  return rows[0] ?? null;
}

export async function setWidgetSecret(sql: Tx, tenantId: string, id: string, encrypted: string): Promise<boolean> {
  const rows = await sql`UPDATE widgets SET identity_secret = ${encrypted}, updated_at = now()
                         WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deleteWidget(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM widgets WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export interface Owner {
  tenantId: string;
  widgetId: string;
  subjectId: string;
}

export async function createConversation(
  sql: Tx,
  owner: Owner & { assistantId: string; subjectKind: "anonymous" | "user" },
  title: string | null,
): Promise<ConversationRow> {
  const id = newId("conv");
  const rows = await sql<ConversationRow[]>`
    INSERT INTO conversations (id, tenant_id, assistant_id, widget_id, subject_id, subject_kind, title)
    VALUES (${id}, ${owner.tenantId}, ${owner.assistantId}, ${owner.widgetId}, ${owner.subjectId},
            ${owner.subjectKind}, ${title})
    RETURNING *`;
  return rows[0]!;
}

/** Only the owning subject (same tenant + widget + subject) can see a conversation. */
export async function getOwnedConversation(sql: Tx, owner: Owner, id: string): Promise<ConversationRow | null> {
  const rows = await sql<ConversationRow[]>`
    SELECT * FROM conversations
    WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND widget_id = ${owner.widgetId}
      AND subject_id = ${owner.subjectId} AND deleted_at IS NULL`;
  return rows[0] ?? null;
}

export async function listOwnedConversations(
  sql: Tx,
  owner: Owner,
  limit: number,
  before: string | null,
): Promise<ConversationRow[]> {
  return sql<ConversationRow[]>`
    SELECT * FROM conversations
    WHERE tenant_id = ${owner.tenantId} AND widget_id = ${owner.widgetId}
      AND subject_id = ${owner.subjectId} AND deleted_at IS NULL
      ${before ? sql`AND (updated_at, id) < (SELECT updated_at, id FROM conversations WHERE id = ${before})` : sql``}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${limit}`;
}

/** Visitors' deletions are permanent (messages, runs and events cascade). */
export async function deleteOwnedConversation(sql: Tx, owner: Owner, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM conversations
    WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND widget_id = ${owner.widgetId}
      AND subject_id = ${owner.subjectId}
    RETURNING id`;
  return rows.length > 0;
}

export async function listMessages(
  sql: Tx,
  tenantId: string,
  conversationId: string,
  limit: number,
  before: string | null,
): Promise<MessageRow[]> {
  // newest first for paging, returned oldest-first to the caller
  const rows = await sql<MessageRow[]>`
    SELECT * FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
      ${before ? sql`AND (created_at, id) < (SELECT created_at, id FROM messages WHERE id = ${before})` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.reverse();
}

export async function getMessage(sql: Tx, tenantId: string, id: string): Promise<MessageRow | null> {
  const rows = await sql<MessageRow[]>`SELECT * FROM messages WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

export async function insertMessage(
  sql: Tx,
  m: { tenantId: string; conversationId: string; role: "user" | "assistant"; content: string; status: Message["status"]; authorName?: string | null },
): Promise<MessageRow> {
  const id = newId("msg");
  const rows = await sql<MessageRow[]>`
    INSERT INTO messages (id, tenant_id, conversation_id, role, content, status, author_name)
    VALUES (${id}, ${m.tenantId}, ${m.conversationId}, ${m.role}, ${m.content}, ${m.status}, ${m.authorName ?? null})
    RETURNING *`;
  return rows[0]!;
}

export async function finishMessage(
  sql: Tx,
  tenantId: string,
  id: string,
  content: string,
  citations: Citation[],
  status: Message["status"],
): Promise<MessageRow> {
  const rows = await sql<MessageRow[]>`
    UPDATE messages SET content = ${content}, citations = ${sql.json(citations as never)}, status = ${status}
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  return rows[0]!;
}

export async function setFeedback(
  sql: Tx,
  tenantId: string,
  messageId: string,
  rating: "up" | "down",
  comment: string | null,
): Promise<void> {
  await sql`UPDATE messages SET feedback = ${rating}, feedback_comment = ${comment}
            WHERE tenant_id = ${tenantId} AND id = ${messageId}`;
}

export async function touchConversation(sql: Tx, tenantId: string, id: string, title?: string): Promise<void> {
  await sql`UPDATE conversations SET updated_at = now(),
              title = COALESCE(title, ${title ?? null})
            WHERE tenant_id = ${tenantId} AND id = ${id}`;
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export const toAdminConversation = (r: ConversationRow & { message_count?: string | number }): AdminConversation => ({
  id: r.id,
  assistantId: r.assistant_id,
  widgetId: r.widget_id,
  subjectId: r.subject_id,
  subjectKind: r.subject_kind,
  title: r.title,
  messageCount: Number(r.message_count ?? 0),
  handoffRequestedAt: isoOrNull(r.handoff_at),
  handoffReason: r.handoff_reason ?? null,
  handoffResolvedAt: isoOrNull(r.handoff_resolved_at ?? null),
  mode: r.mode,
  assignee: r.mode === "human" ? { id: r.assignee_id, name: r.assignee_name ?? "" } : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function adminListConversations(
  sql: Tx,
  tenantId: string,
  limit: number,
  before: string | null,
  filter: { handoff?: "waiting" | "active" | "resolved" | "any" | undefined; assigneeId?: string | undefined } = {},
): Promise<AdminConversation[]> {
  const h = filter.handoff;
  const rows = await sql<(ConversationRow & { message_count: string })[]>`
    SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    WHERE c.tenant_id = ${tenantId}
      ${before ? sql`AND (c.updated_at, c.id) < (SELECT updated_at, id FROM conversations WHERE id = ${before})` : sql``}
      ${h === "any" ? sql`AND c.handoff_at IS NOT NULL` : sql``}
      ${h === "waiting" ? sql`AND c.handoff_at IS NOT NULL AND c.handoff_resolved_at IS NULL AND c.mode = 'assistant'` : sql``}
      ${h === "active" ? sql`AND c.mode = 'human'` : sql``}
      ${h === "resolved" ? sql`AND c.handoff_resolved_at IS NOT NULL AND c.mode = 'assistant'` : sql``}
      ${filter.assigneeId ? sql`AND c.assignee_id = ${filter.assigneeId}` : sql``}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ${limit}`;
  return rows.map(toAdminConversation);
}

export async function adminGetConversation(sql: Tx, tenantId: string, id: string): Promise<ConversationRow | null> {
  const rows = await sql<ConversationRow[]>`SELECT * FROM conversations WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Knowledge sources and documents
// ---------------------------------------------------------------------------

export async function listSources(sql: Tx, tenantId: string): Promise<SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT s.*, (SELECT count(*) FROM documents d WHERE d.source_id = s.id) AS document_count
    FROM knowledge_sources s WHERE s.tenant_id = ${tenantId} ORDER BY s.created_at`;
}

export async function getSource(sql: Tx, tenantId: string, id: string): Promise<SourceRow | null> {
  const rows = await sql<SourceRow[]>`
    SELECT s.*, (SELECT count(*) FROM documents d WHERE d.source_id = s.id) AS document_count
    FROM knowledge_sources s WHERE s.tenant_id = ${tenantId} AND s.id = ${id}`;
  return rows[0] ?? null;
}

export async function createSource(
  sql: Tx,
  tenantId: string,
  input: { name: string; type: SourceRow["type"]; url: string | null; access: string[]; maxPages: number; syncIntervalHours?: number | null },
): Promise<SourceRow> {
  const id = newId("src");
  const rows = await sql<SourceRow[]>`
    INSERT INTO knowledge_sources (id, tenant_id, name, type, url, access, max_pages, sync_interval_hours)
    VALUES (${id}, ${tenantId}, ${input.name}, ${input.type}, ${input.url}, ${sql.array(input.access)}, ${input.maxPages},
            ${input.type === "manual" ? null : (input.syncIntervalHours ?? null)})
    RETURNING *, 0 AS document_count`;
  return rows[0]!;
}

export async function updateSource(
  sql: Sql,
  tenantId: string,
  id: string,
  p: { name?: string; url?: string; access?: string[]; maxPages?: number; syncIntervalHours?: number | null },
): Promise<SourceRow | null> {
  return sql.begin(async (tx) => {
    const c = await getSource(tx, tenantId, id);
    if (!c) return null;
    const access = p.access ?? c.access;
    await tx`
      UPDATE knowledge_sources SET name = ${p.name ?? c.name}, url = ${c.type === "manual" ? null : (p.url ?? c.url)},
        access = ${tx.array(access)}, max_pages = ${p.maxPages ?? c.max_pages},
        sync_interval_hours = ${c.type === "manual" ? null : p.syncIntervalHours !== undefined ? p.syncIntervalHours : c.sync_interval_hours},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${id}`;
    if (p.access) await tx`UPDATE chunks SET access = ${tx.array(access)} WHERE tenant_id = ${tenantId} AND source_id = ${id}`;
    return getSource(tx, tenantId, id);
  });
}

/** Crawled sources whose sync interval has elapsed and that are not already queued. */
export async function dueSources(sql: Sql, limit = 50): Promise<{ id: string; tenant_id: string }[]> {
  return sql<{ id: string; tenant_id: string }[]>`
    SELECT id, tenant_id FROM knowledge_sources
    WHERE type <> 'manual' AND sync_interval_hours IS NOT NULL AND status NOT IN ('queued', 'running')
      AND tenant_id IN (SELECT id FROM tenants WHERE status = 'active')
      -- updated_at moves with every status change, so it marks the last attempt (successful or not).
      AND updated_at < now() - make_interval(hours => sync_interval_hours)
    ORDER BY updated_at
    LIMIT ${limit}`;
}

export async function deleteSource(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM knowledge_sources WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function setSourceStatus(
  sql: Tx,
  tenantId: string,
  id: string,
  status: SourceRow["status"],
  error: string | null = null,
): Promise<void> {
  await sql`
    UPDATE knowledge_sources SET status = ${status}, last_error = ${error}, updated_at = now(),
      last_ingested_at = CASE WHEN ${status} = 'succeeded' THEN now() ELSE last_ingested_at END
    WHERE tenant_id = ${tenantId} AND id = ${id}`;
}

export async function listDocuments(
  sql: Tx,
  tenantId: string,
  sourceId: string,
  limit: number,
  offset: number,
): Promise<KnowledgeDocument[]> {
  const rows = await sql<
    { id: string; source_id: string; title: string; url: string | null; chunk_count: string; updated_at: Date }[]
  >`
    SELECT d.id, d.source_id, d.title, d.url, d.updated_at,
           (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
    FROM documents d WHERE d.tenant_id = ${tenantId} AND d.source_id = ${sourceId}
    ORDER BY d.title LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    url: r.url,
    chunkCount: Number(r.chunk_count),
    updatedAt: iso(r.updated_at),
  }));
}

export async function deleteDocument(sql: Tx, tenantId: string, sourceId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM documents WHERE tenant_id = ${tenantId} AND source_id = ${sourceId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}
