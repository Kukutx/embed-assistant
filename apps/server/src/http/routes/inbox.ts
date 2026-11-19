/**
 * Live agent inbox: people on the team take over handed-off conversations.
 *
 * Taking over switches the conversation to `human` mode: the AI stops
 * answering, the visitor's messages are stored and forwarded (conversation
 * events and the `message.received` webhook), and replies written here reach
 * the widget in real time. Handing back returns the conversation to the AI.
 *
 * The same endpoints serve helpdesk bridges: an API key can take over and
 * reply with a display name, so a ticketing system can carry the chat.
 */
import type { Context, Hono } from "hono";
import { AdminConversation, AgentReplyRequest, AssignRequest, ErrorCode, Message, ReleaseRequest } from "@embed-assistant/protocol";
import { adminGetConversation, insertMessage, toAdminConversation, toConversation, toMessage, type ConversationRow } from "../../db/store.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const COUNT = "(SELECT count(*) FROM messages m WHERE m.conversation_id = conversations.id) AS message_count";

export function inboxRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const A = "Admin: inbox";

  const displayName = (c: Context<AppEnv>, requested?: string): string => {
    const a = c.get("actor");
    return requested ?? a.name ?? a.email?.split("@")[0] ?? "Support";
  };

  async function load(c: Context<AppEnv>): Promise<ConversationRow> {
    const conv = await adminGetConversation(sql, c.get("tenantId"), param(c, "id"));
    if (!conv) throw notFound("conversation");
    return conv;
  }

  /** Stop any AI answer in progress (here, or on another instance via its heartbeat). */
  async function stopRuns(conversationId: string): Promise<void> {
    const active = await sql<{ id: string }[]>`SELECT id FROM runs WHERE conversation_id = ${conversationId} AND status IN ('queued', 'running')`;
    for (const r of active) {
      if (!s.executor.cancelLocal(r.id)) await sql`UPDATE runs SET status = 'cancelled' WHERE id = ${r.id} AND status IN ('queued', 'running')`;
    }
  }

  async function announce(row: ConversationRow): Promise<void> {
    await s.bus.appendConversation(row.id, "conversation.updated", { conversation: toConversation(row) });
  }

  async function takeOver(c: Context<AppEnv>, conv: ConversationRow, name: string, force: boolean): Promise<ConversationRow> {
    const actor = c.get("actor");
    const userId = actor.type === "user" ? actor.id : null;
    // Users are identified by id; API keys (helpdesk bridges) by the display name they use.
    const same = userId !== null ? conv.assignee_id === userId : conv.assignee_id === null && conv.assignee_name === name;
    if (conv.mode === "human" && !force && !same) {
      throw new ApiError(ErrorCode.Conflict, `${conv.assignee_name ?? "someone"} is already handling this conversation (send force: true to take over)`);
    }
    const [row] = await sql<ConversationRow[]>`
      UPDATE conversations SET mode = 'human', assignee_id = ${userId}, assignee_name = ${name}, assigned_at = now(),
        handoff_at = coalesce(handoff_at, now()), handoff_resolved_at = NULL
      WHERE tenant_id = ${conv.tenant_id} AND id = ${conv.id} RETURNING *, ${sql.unsafe(COUNT)}`;
    await stopRuns(conv.id);
    if (conv.mode !== "human" || conv.assignee_name !== name) await announce(row!);
    return row!;
  }

  // Registered after /v1/admin/conversations/export so that path keeps working.
  route(app, { method: "get", path: "/v1/admin/conversations/{id}", tag: A, summary: "Get a conversation (handoff state, assignee)", auth: "admin", response: { status: 200, schema: AdminConversation } },
    async (c) => {
      const [row] = await sql<(ConversationRow & { message_count: string })[]>`
        SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c WHERE c.tenant_id = ${c.get("tenantId")} AND c.id = ${param(c, "id")}`;
      if (!row) throw notFound("conversation");
      return c.json(toAdminConversation(row));
    });

  route(app, {
      method: "post", path: "/v1/admin/conversations/{id}/assign", tag: A, summary: "Take over a conversation",
      description: "Switches it to `human` mode: the AI stops answering and the visitor sees that a person joined.",
      auth: "admin", body: AssignRequest, response: { status: 200, schema: AdminConversation },
    },
    async (c, { body }) => {
      const conv = await load(c);
      const row = await takeOver(c, conv, displayName(c, body.displayName), body.force);
      return c.json(toAdminConversation(row));
    });

  route(app, {
      method: "post", path: "/v1/admin/conversations/{id}/reply", tag: A, summary: "Reply to the visitor as a person",
      description: "Takes the conversation over first if nobody is handling it. The reply reaches the widget immediately.",
      auth: "admin", body: AgentReplyRequest, response: { status: 201, schema: Message },
    },
    async (c, { body }) => {
      let conv = await load(c);
      const name = displayName(c, body.displayName ?? (conv.mode === "human" && conv.assignee_id === null ? (conv.assignee_name ?? undefined) : undefined));
      if (conv.mode !== "human") conv = await takeOver(c, conv, name, false);
      const msg = await insertMessage(sql, { tenantId: conv.tenant_id, conversationId: conv.id, role: "assistant", content: body.content, status: "complete", authorName: name });
      await sql`UPDATE conversations SET updated_at = now() WHERE id = ${conv.id}`;
      const message = toMessage(msg);
      await s.bus.appendConversation(conv.id, "message.created", { message });
      return c.json(message, 201);
    });

  route(app, {
      method: "post", path: "/v1/admin/conversations/{id}/release", tag: A, summary: "Hand the conversation back to the assistant",
      description: "With `resolve: true` (default) the handoff leaves the inbox; with false it goes back to the waiting queue.",
      auth: "admin", body: ReleaseRequest, response: { status: 200, schema: AdminConversation },
    },
    async (c, { body }) => {
      const conv = await load(c);
      const [row] = await sql<ConversationRow[]>`
        UPDATE conversations SET mode = 'assistant', assignee_id = NULL, assignee_name = NULL, assigned_at = NULL,
          handoff_resolved_at = ${body.resolve ? sql`now()` : null}
        WHERE tenant_id = ${conv.tenant_id} AND id = ${conv.id} RETURNING *, ${sql.unsafe(COUNT)}`;
      if (conv.mode === "human") await announce(row!);
      return c.json(toAdminConversation(row!));
    });
}
