import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  Conversation,
  ConversationList,
  CreateConversationRequest,
  CreateRunRequest,
  CreateRunResponse,
  ErrorCode,
  FeedbackRequest,
  MessageList,
  Run,
  isTerminalEvent,
} from "@embed-assistant/protocol";
import {
  createConversation,
  getAssistant,
  getMessage,
  getOwnedConversation,
  insertMessage,
  listMessages,
  listOwnedConversations,
  setFeedback,
  softDeleteConversation,
  toConversation,
  toMessage,
  touchConversation,
  type MessageRow,
  type Owner,
  type RunRow,
} from "../../db/store.js";
import { ApiError, badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { tokensUsedToday } from "../../lib/rateLimit.js";
import { iso } from "../../lib/time.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const Page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(64).optional(),
});

const EventsQuery = z.object({
  /** Resume after this sequence number (alternative to the Last-Event-ID header). */
  after: z.coerce.number().int().min(0).optional(),
});

const SSE_KEEPALIVE_MS = 15_000;
const SSE_POLL_MS = 2_000;
const SSE_MAX_MS = 5 * 60_000;

const owner = (c: Context<AppEnv>): Owner => {
  const s = c.get("session");
  return { tenantId: s.tenantId, widgetId: s.widgetId, subjectId: s.subjectId };
};

const toRun = (r: Pick<RunRow, "id" | "conversation_id" | "status" | "created_at">): Run => ({
  id: r.id,
  conversationId: r.conversation_id,
  status: r.status,
  createdAt: iso(r.created_at),
});

export function chatRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;

  async function ownedConversationOr404(c: Context<AppEnv>, id: string) {
    const conv = await getOwnedConversation(sql, owner(c), id);
    if (!conv) throw notFound("conversation");
    return conv;
  }

  /** A run is visible to whoever owns its conversation. */
  async function ownedRunOr404(c: Context<AppEnv>, runId: string): Promise<RunRow> {
    const o = owner(c);
    const rows = await sql<RunRow[]>`
      SELECT r.* FROM runs r JOIN conversations cv ON cv.id = r.conversation_id
      WHERE r.id = ${runId} AND r.tenant_id = ${o.tenantId} AND cv.widget_id = ${o.widgetId}
        AND cv.subject_id = ${o.subjectId} AND cv.deleted_at IS NULL`;
    if (!rows[0]) throw notFound("run");
    return rows[0];
  }

  route(
    app,
    {
      method: "post",
      path: "/v1/conversations",
      tag: "Chat",
      summary: "Create a conversation",
      auth: "session",
      body: CreateConversationRequest,
      response: { status: 201, schema: Conversation },
    },
    async (c, { body }) => {
      const sess = c.get("session");
      const conv = await createConversation(
        sql,
        { ...owner(c), assistantId: c.get("widget").assistant_id, subjectKind: sess.subjectKind },
        body.title ?? null,
      );
      return c.json(toConversation(conv), 201);
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/v1/conversations",
      tag: "Chat",
      summary: "List my conversations (most recent first)",
      auth: "session",
      query: Page,
      response: { status: 200, schema: ConversationList },
    },
    async (c, { query }) => {
      const rows = await listOwnedConversations(sql, owner(c), query.limit + 1, query.cursor ?? null);
      const items = rows.slice(0, query.limit);
      const body: ConversationList = {
        items: items.map(toConversation),
        nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      };
      return c.json(body);
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/v1/conversations/{id}",
      tag: "Chat",
      summary: "Get a conversation",
      auth: "session",
      response: { status: 200, schema: Conversation },
    },
    async (c) => c.json(toConversation(await ownedConversationOr404(c, param(c, "id")))),
  );

  route(
    app,
    {
      method: "delete",
      path: "/v1/conversations/{id}",
      tag: "Chat",
      summary: "Delete a conversation",
      auth: "session",
      response: { status: 204, description: "Deleted" },
    },
    async (c) => {
      if (!(await softDeleteConversation(sql, owner(c), param(c, "id")))) throw notFound("conversation");
      return c.body(null, 204);
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/v1/conversations/{id}/messages",
      tag: "Chat",
      summary: "List messages (oldest first; page backwards with cursor)",
      auth: "session",
      query: Page,
      response: { status: 200, schema: MessageList },
    },
    async (c, { query }) => {
      const conv = await ownedConversationOr404(c, param(c, "id"));
      const rows = await listMessages(sql, conv.tenant_id, conv.id, query.limit + 1, query.cursor ?? null);
      // rows are oldest-first; an extra row means there is an older page.
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(1) : rows;
      const body: MessageList = { items: items.map(toMessage), nextCursor: hasMore ? (items[0]?.id ?? null) : null };
      return c.json(body);
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/v1/conversations/{id}/runs",
      tag: "Chat",
      summary: "Ask a question (starts a streaming run)",
      description:
        "Stores the user message and starts generating the answer. Follow progress on GET /v1/runs/{id}/events. " +
        "Only one run may be active per conversation. Sending the same idempotencyKey again returns the original run.",
      auth: "session",
      body: CreateRunRequest,
      response: { status: 202, schema: CreateRunResponse },
    },
    async (c, { body }) => {
      const sess = c.get("session");
      const widget = c.get("widget");
      const conv = await ownedConversationOr404(c, param(c, "id"));

      if (body.idempotencyKey) {
        const existing = await findIdempotentRun(conv.id, body.idempotencyKey);
        if (existing) return c.json(existing, 202);
      }

      await s.limiter.hit(`run:sub:${sess.widgetId}:${sess.subjectId}`, s.cfg.RATE_LIMIT_RUNS_PER_MINUTE, 60);
      await s.limiter.hit(`run:ip:${c.get("clientIp")}`, s.cfg.RATE_LIMIT_RUNS_PER_HOUR_IP, 3600);
      await enforceBudget(widget.tenant_id, widget.id, widget.daily_token_budget);

      const assistant = await getAssistant(sql, widget.tenant_id, widget.assistant_id);
      if (!assistant) throw notFound("assistant");

      const created = await sql.begin(async (tx) => {
        // Serialise run creation per conversation (one active run at a time).
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${conv.id}, 0))`;
        if (body.idempotencyKey) {
          const again = await tx<RunRow[]>`SELECT * FROM runs WHERE conversation_id = ${conv.id} AND idempotency_key = ${body.idempotencyKey}`;
          if (again[0]) return { replay: again[0] };
        }
        const active = await tx`
          SELECT 1 FROM runs WHERE conversation_id = ${conv.id} AND status IN ('queued', 'running') LIMIT 1`;
        if (active.length) {
          throw new ApiError(ErrorCode.Conflict, "an answer is already being generated in this conversation");
        }
        const userMessage = await insertMessage(tx, {
          tenantId: conv.tenant_id,
          conversationId: conv.id,
          role: "user",
          content: body.content,
          status: "complete",
        });
        const runRows = await tx<RunRow[]>`
          INSERT INTO runs (id, tenant_id, conversation_id, widget_id, user_message_id, status, model_alias,
                            assistant_version, idempotency_key, context)
          VALUES (${newId("run")}, ${conv.tenant_id}, ${conv.id}, ${widget.id}, ${userMessage.id}, 'queued',
                  ${assistant.model_alias}, ${assistant.version}, ${body.idempotencyKey ?? null},
                  ${body.context ? tx.json(body.context as never) : null})
          RETURNING *`;
        await touchConversation(tx, conv.tenant_id, conv.id, titleFrom(body.content));
        return { run: runRows[0]!, userMessage };
      });

      if ("replay" in created) {
        const replay = await runResponse(created.replay!);
        return c.json(replay, 202);
      }

      s.executor.start({
        runId: created.run.id,
        tenantId: conv.tenant_id,
        conversationId: conv.id,
        userMessage: created.userMessage,
        assistant,
        access: sess.access,
        context: body.context,
      });
      const res: CreateRunResponse = { run: toRun(created.run), userMessage: toMessage(created.userMessage) };
      return c.json(res, 202);
    },
  );

  async function findIdempotentRun(conversationId: string, key: string): Promise<CreateRunResponse | null> {
    const rows = await sql<RunRow[]>`SELECT * FROM runs WHERE conversation_id = ${conversationId} AND idempotency_key = ${key}`;
    return rows[0] ? runResponse(rows[0]) : null;
  }

  async function runResponse(run: RunRow): Promise<CreateRunResponse> {
    const msg = (await getMessage(sql, run.tenant_id, run.user_message_id)) as MessageRow;
    return { run: toRun(run), userMessage: toMessage(msg) };
  }

  async function enforceBudget(tenantId: string, widgetId: string, widgetBudget: number | null): Promise<void> {
    let budget = widgetBudget;
    if (budget === null) {
      const t = await sql<{ daily_token_budget: number | null }[]>`SELECT daily_token_budget FROM tenants WHERE id = ${tenantId}`;
      budget = t[0]?.daily_token_budget ?? s.cfg.DEFAULT_DAILY_TOKEN_BUDGET;
    }
    if (!budget) return;
    const used = await tokensUsedToday(sql, tenantId, widgetId);
    if (used >= budget) {
      const now = new Date();
      const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      throw new ApiError(
        ErrorCode.BudgetExceeded,
        "this assistant has reached its daily usage limit, please try again later",
        undefined,
        Math.ceil((tomorrow - now.getTime()) / 1000),
      );
    }
  }

  route(
    app,
    {
      method: "get",
      path: "/v1/runs/{id}",
      tag: "Chat",
      summary: "Get a run",
      auth: "session",
      response: { status: 200, schema: Run },
    },
    async (c) => c.json(toRun(await ownedRunOr404(c, param(c, "id")))),
  );

  route(
    app,
    {
      method: "post",
      path: "/v1/runs/{id}/cancel",
      tag: "Chat",
      summary: "Stop generating",
      auth: "session",
      response: { status: 202, schema: Run },
    },
    async (c) => {
      const run = await ownedRunOr404(c, param(c, "id"));
      if (run.status === "queued" || run.status === "running") {
        // Local executor aborts now; an executor on another instance sees the status on its next heartbeat.
        if (!s.executor.cancelLocal(run.id)) {
          await sql`UPDATE runs SET status = 'cancelled' WHERE id = ${run.id} AND status IN ('queued', 'running')`;
        }
      }
      const fresh = await ownedRunOr404(c, run.id);
      return c.json(toRun(fresh), 202);
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/v1/runs/{id}/events",
      tag: "Chat",
      summary: "Stream run events (Server-Sent Events)",
      description:
        "Each frame has `id: <seq>`, `event: <type>` and `data: <RunEvent JSON>`. Reconnect with the Last-Event-ID " +
        "header (or ?after=<seq>) to resume without gaps. The stream closes after run.completed, run.failed or run.cancelled.",
      auth: "session",
      query: EventsQuery,
      response: { status: 200, description: "text/event-stream of RunEvent", contentType: "text/event-stream" },
    },
    async (c, { query }) => {
      const run = await ownedRunOr404(c, param(c, "id"));
      const header = Number.parseInt(c.req.header("last-event-id") ?? "", 10);
      let last = Number.isFinite(header) && header >= 0 ? header : (query.after ?? 0);
      c.header("Cache-Control", "no-store");
      c.header("X-Accel-Buffering", "no");

      return streamSSE(c, async (stream) => {
        let wake: (() => void) | null = null;
        const unsubscribe = s.bus.onAnnounce(run.id, () => wake?.());
        let closed = false;
        stream.onAbort(() => {
          closed = true;
          wake?.();
        });
        const started = Date.now();
        let lastWrite = Date.now();
        try {
          while (!closed && Date.now() - started < SSE_MAX_MS) {
            const events = await s.bus.since(run.id, last);
            for (const e of events) {
              await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
              last = e.seq;
              lastWrite = Date.now();
              if (isTerminalEvent(e.type)) return;
            }
            if (Date.now() - lastWrite >= SSE_KEEPALIVE_MS) {
              await stream.write(": keepalive\n\n");
              lastWrite = Date.now();
            }
            // Wait for an announcement, with a poll fallback in case a NOTIFY was missed.
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, SSE_POLL_MS);
              wake = () => {
                clearTimeout(t);
                resolve();
              };
            });
            wake = null;
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/v1/messages/{id}/feedback",
      tag: "Chat",
      summary: "Rate an answer",
      auth: "session",
      body: FeedbackRequest,
      response: { status: 204, description: "Recorded" },
    },
    async (c, { body }) => {
      if (!c.get("widget").features.feedback) throw badRequest("feedback is disabled for this widget");
      const sess = c.get("session");
      const msg = await getMessage(sql, sess.tenantId, param(c, "id"));
      if (!msg || msg.role !== "assistant") throw notFound("message");
      await ownedConversationOr404(c, msg.conversation_id);
      await setFeedback(sql, sess.tenantId, msg.id, body.rating, body.comment ?? null);
      return c.body(null, 204);
    },
  );
}

function titleFrom(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}
