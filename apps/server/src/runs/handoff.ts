import type { HandoffResult, PageContext } from "@embed-assistant/protocol";
import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import type { AssistantRow } from "../db/store.js";
import type { ModelRegistry } from "../models/registry.js";
import { emitWebhook } from "../webhooks/webhooks.js";
import { auxAlias, summarizeForHandoff } from "./assist.js";

export interface HandoffParams {
  tenantId: string;
  conversationId: string;
  assistant: AssistantRow;
  reason: string | null;
  /** Who asked: the visitor (button) or the assistant (tool call). */
  trigger: "visitor" | "assistant";
  subject: { id: string; kind: "anonymous" | "user"; name: string | null; email?: string | null };
  context?: PageContext | null | undefined;
}

/** Repeated requests within this window do not notify the team again. */
const RENOTIFY_AFTER = "10 minutes";

/**
 * Mark the conversation as handed off and notify the team through the
 * `handoff.requested` webhook (with transcript and an AI summary), so any
 * helpdesk, inbox or chat tool can take over. Vendor-neutral by design.
 */
export async function requestHandoff(deps: { sql: Sql; models: ModelRegistry; log: Logger }, p: HandoffParams): Promise<HandoffResult> {
  const { sql } = deps;
  // A new request after the last one was resolved puts the conversation back in the inbox.
  await sql`UPDATE conversations SET handoff_resolved_at = NULL WHERE tenant_id = ${p.tenantId} AND id = ${p.conversationId} AND handoff_resolved_at IS NOT NULL`;
  const updated = await sql<{ handoff_at: Date; widget_id: string; title: string | null }[]>`
    UPDATE conversations SET handoff_at = now(), handoff_reason = ${p.reason}
    WHERE tenant_id = ${p.tenantId} AND id = ${p.conversationId}
      AND (handoff_at IS NULL OR handoff_at < now() - ${RENOTIFY_AFTER}::interval)
    RETURNING handoff_at, widget_id, title`;
  const result = (at: Date): HandoffResult => ({
    message: p.assistant.handoff.message,
    url: p.assistant.handoff.url,
    requestedAt: at.toISOString(),
  });
  const first = updated[0];
  if (!first) {
    const rows = await sql<{ handoff_at: Date | null }[]>`
      SELECT handoff_at FROM conversations WHERE tenant_id = ${p.tenantId} AND id = ${p.conversationId}`;
    return result(rows[0]?.handoff_at ?? new Date());
  }

  const messages = await sql<{ id: string; role: string; content: string; citations: { title: string; url: string | null }[]; created_at: Date }[]>`
    SELECT id, role, content, citations, created_at FROM messages
    WHERE tenant_id = ${p.tenantId} AND conversation_id = ${p.conversationId} AND status = 'complete'
    ORDER BY created_at DESC, id DESC LIMIT 100`;
  messages.reverse();
  const transcript = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.citations.map((c) => ({ title: c.title, url: c.url })),
    createdAt: m.created_at.toISOString(),
  }));
  const summary = await summarizeForHandoff(deps.models, {
    alias: auxAlias(deps.models, p.assistant.model_alias),
    transcript,
    reason: p.reason,
  }).catch(() => null);

  await emitWebhook(sql, p.tenantId, "handoff.requested", {
    conversation: { id: p.conversationId, widgetId: first.widget_id, assistantId: p.assistant.id, title: first.title },
    subject: p.subject,
    trigger: p.trigger,
    reason: p.reason,
    summary,
    pageContext: p.context ?? null,
    transcript,
    requestedAt: first.handoff_at.toISOString(),
  }).catch((err) => deps.log.warn({ err }, "handoff webhook enqueue failed"));
  return result(first.handoff_at);
}
