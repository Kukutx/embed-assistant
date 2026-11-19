import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  Action,
  ActionInput,
  ActionPatch,
  ActionTestRequest,
  ActionTestResult,
  ApiKey,
  ApiKeyInput,
  CreatedApiKey,
  CreatedWebhook,
  ErrorCode,
  Insights,
  TenantSettings,
  TenantSettingsPatch,
  Webhook,
  WebhookDelivery,
  WebhookInput,
  WebhookPatch,
  AuditEventList,
  type GuardrailKind,
} from "@embed-assistant/protocol";
import { callAction, createAction, deleteAction, getAction, listActions, toAction, updateAction } from "../../actions/actions.js";
import { generateAdminKey } from "../../auth/adminKey.js";
import { insertAdminKey, type KeyRow } from "../../db/store.js";
import { decrypt } from "../../lib/crypto.js";
import { ApiError, badRequest, notFound } from "../../lib/errors.js";
import { isSupportedSchema } from "../../lib/jsonSchema.js";
import { iso, isoOrNull } from "../../lib/time.js";
import { safeFetch } from "../../knowledge/safeFetch.js";
import { HANDOFF_TOOL, SEARCH_TOOL } from "../../runs/tools.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  newWebhookSecret,
  signWebhook,
  toWebhook,
  updateWebhook,
} from "../../webhooks/webhooks.js";
import { newId } from "../../lib/ids.js";
import { listAudit, toAuditEvent } from "../../lib/audit.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const tid = (c: Context<AppEnv>) => c.get("tenantId");
const Days = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const RESERVED_TOOL_NAMES = new Set([SEARCH_TOOL, HANDOFF_TOOL]);

const toKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes as ApiKey["scopes"],
  access: r.access,
  createdAt: iso(r.created_at),
  lastUsedAt: isoOrNull(r.last_used_at),
});

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

export function adminAgentRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const A = "Admin";

  // ------------------------------------------------------------------- actions
  const checkAction = (a: { name?: string; parameters?: Record<string, unknown> }) => {
    if (a.name && RESERVED_TOOL_NAMES.has(a.name)) throw badRequest(`"${a.name}" is a built-in tool name`);
    if (a.parameters && !isSupportedSchema(a.parameters)) throw badRequest("parameters is not a supported JSON Schema");
  };

  route(app, { method: "get", path: "/v1/admin/actions", tag: A, summary: "List actions (tools)", auth: "admin", response: { status: 200, schema: z.array(Action) } },
    async (c) => c.json((await listActions(sql, tid(c))).map(toAction)));

  route(app, {
      method: "post", path: "/v1/admin/actions", tag: A, summary: "Create an action",
      description:
        "An HTTP endpoint the assistant may call as a tool. Requests are signed with the widget identity secret " +
        "(`EA-Signature: t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<METHOD>.<url>.<EA-User-Id>.<body>\">`). Attach it to an assistant via actionIds.",
      auth: "admin", body: ActionInput, response: { status: 201, schema: Action },
    },
    async (c, { body }) => {
      checkAction(body);
      try {
        return c.json(toAction(await createAction(sql, s.secretsKey, tid(c), body)), 201);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(ErrorCode.Conflict, `an action named "${body.name}" already exists`);
        throw err;
      }
    });

  route(app, { method: "get", path: "/v1/admin/actions/{id}", tag: A, summary: "Get an action", auth: "admin", response: { status: 200, schema: Action } },
    async (c) => {
      const a = await getAction(sql, tid(c), param(c, "id"));
      if (!a) throw notFound("action");
      return c.json(toAction(a));
    });

  route(app, { method: "patch", path: "/v1/admin/actions/{id}", tag: A, summary: "Update an action", auth: "admin", body: ActionPatch, response: { status: 200, schema: Action } },
    async (c, { body }) => {
      checkAction(body);
      try {
        const a = await updateAction(sql, s.secretsKey, tid(c), param(c, "id"), Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        if (!a) throw notFound("action");
        return c.json(toAction(a));
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(ErrorCode.Conflict, "an action with that name already exists");
        throw err;
      }
    });

  route(app, { method: "delete", path: "/v1/admin/actions/{id}", tag: A, summary: "Delete an action", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteAction(sql, tid(c), param(c, "id")))) throw notFound("action");
      await sql`UPDATE assistants SET action_ids = array_remove(action_ids, ${param(c, "id")}) WHERE tenant_id = ${tid(c)}`;
      return c.body(null, 204);
    });

  route(app, { method: "post", path: "/v1/admin/actions/{id}/test", tag: A, summary: "Call an action with test arguments", auth: "admin", body: ActionTestRequest, response: { status: 200, schema: ActionTestResult } },
    async (c, { body }) => {
      const a = await getAction(sql, tid(c), param(c, "id"));
      if (!a) throw notFound("action");
      const r = await callAction(a, body.arguments, {
        key: s.secretsKey,
        signingSecret: null,
        caller: { subjectId: "admin-test", subjectKind: "user", name: "Admin test" },
        allowPrivate: s.cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
      });
      return c.json(r);
    });

  // ------------------------------------------------------------------ webhooks
  route(app, { method: "get", path: "/v1/admin/webhooks", tag: A, summary: "List webhooks", auth: "admin", response: { status: 200, schema: z.array(Webhook) } },
    async (c) => c.json((await listWebhooks(sql, tid(c))).map(toWebhook)));

  route(app, {
      method: "post", path: "/v1/admin/webhooks", tag: A, summary: "Create a webhook",
      description:
        "Deliveries follow the Standard Webhooks specification (headers webhook-id, webhook-timestamp, webhook-signature). " +
        "The signing secret is returned once. Failed deliveries are retried with backoff for about 4 hours.",
      auth: "admin", body: WebhookInput, response: { status: 201, schema: CreatedWebhook },
    },
    async (c, { body }) => {
      const secret = newWebhookSecret();
      const w = await createWebhook(sql, s.secretsKey, tid(c), body, secret);
      return c.json({ webhook: toWebhook(w), secret }, 201);
    });

  route(app, { method: "patch", path: "/v1/admin/webhooks/{id}", tag: A, summary: "Update a webhook", auth: "admin", body: WebhookPatch, response: { status: 200, schema: Webhook } },
    async (c, { body }) => {
      const w = await updateWebhook(sql, s.secretsKey, tid(c), param(c, "id"), Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      if (!w) throw notFound("webhook");
      return c.json(toWebhook(w));
    });

  route(app, { method: "post", path: "/v1/admin/webhooks/{id}/rotate-secret", tag: A, summary: "Rotate a webhook signing secret", auth: "admin", response: { status: 200, schema: CreatedWebhook } },
    async (c) => {
      const secret = newWebhookSecret();
      const w = await updateWebhook(sql, s.secretsKey, tid(c), param(c, "id"), { secret });
      if (!w) throw notFound("webhook");
      return c.json({ webhook: toWebhook(w), secret });
    });

  route(app, { method: "delete", path: "/v1/admin/webhooks/{id}", tag: A, summary: "Delete a webhook", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteWebhook(sql, tid(c), param(c, "id")))) throw notFound("webhook");
      return c.body(null, 204);
    });

  route(app, { method: "post", path: "/v1/admin/webhooks/{id}/test", tag: A, summary: "Send a test event now", auth: "admin", response: { status: 200, schema: z.object({ ok: z.boolean(), status: z.number().int(), error: z.string().nullable() }) } },
    async (c) => {
      const w = await getWebhook(sql, tid(c), param(c, "id"));
      if (!w) throw notFound("webhook");
      const id = newId("evt");
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ type: "webhook.test", timestamp: new Date().toISOString(), data: { webhookId: w.id } });
      try {
        const res = await safeFetch(w.url, {
          allowPrivate: s.cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
          method: "POST",
          body,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          accept: "*/*",
          userAgent: "embed-assistant-webhooks/1.0",
          headers: {
            "content-type": "application/json",
            "webhook-id": id,
            "webhook-timestamp": String(ts),
            "webhook-signature": signWebhook(decrypt(s.secretsKey, w.secret), id, ts, body),
          },
        });
        const ok = res.status >= 200 && res.status < 300;
        return c.json({ ok, status: res.status, error: ok ? null : res.body.slice(0, 300) });
      } catch (err) {
        return c.json({ ok: false, status: 0, error: (err as Error).message });
      }
    });

  route(app, { method: "get", path: "/v1/admin/webhooks/{id}/deliveries", tag: A, summary: "Recent deliveries of a webhook", auth: "admin", response: { status: 200, schema: z.array(WebhookDelivery) } },
    async (c) => {
      const rows = await sql<{ id: string; payload: { event: string }; status: "queued"; attempts: number; last_error: string | null; created_at: Date; updated_at: Date }[]>`
        SELECT id, payload, status, attempts, last_error, created_at, updated_at FROM jobs
        WHERE tenant_id = ${tid(c)} AND type = 'deliver_webhook' AND payload->>'webhookId' = ${param(c, "id")}
        ORDER BY created_at DESC LIMIT 50`;
      return c.json(rows.map((r) => ({ id: r.id, event: r.payload.event, status: r.status, attempts: r.attempts, lastError: r.last_error, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })));
    });

  // ------------------------------------------------------------------ API keys
  route(app, { method: "get", path: "/v1/admin/keys", tag: A, summary: "List API keys", auth: "admin", response: { status: 200, schema: z.array(ApiKey) } },
    async (c) => {
      const rows = await sql<KeyRow[]>`
        SELECT id, tenant_id, name, prefix, scopes, access, created_at, last_used_at FROM admin_keys
        WHERE tenant_id = ${tid(c)} AND revoked_at IS NULL ORDER BY created_at`;
      return c.json(rows.map(toKey));
    });

  route(app, { method: "post", path: "/v1/admin/keys", tag: A, summary: "Create an API key", description: "The key is returned once. Use scope `mcp` for MCP clients (read-only knowledge access).", auth: "admin", body: ApiKeyInput, response: { status: 201, schema: CreatedApiKey } },
    async (c, { body }) => {
      const k = generateAdminKey(body.scopes);
      const id = await insertAdminKey(sql, tid(c), body.name, k.hash, k.prefix, body.scopes, body.access);
      const rows = await sql<KeyRow[]>`SELECT id, tenant_id, name, prefix, scopes, access, created_at, last_used_at FROM admin_keys WHERE id = ${id}`;
      return c.json({ apiKey: toKey(rows[0]!), key: k.key }, 201);
    });

  route(app, { method: "delete", path: "/v1/admin/keys/{id}", tag: A, summary: "Revoke an API key", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (param(c, "id") === c.get("actor").id) throw badRequest("you cannot revoke the key you are using");
      const rows = await sql`UPDATE admin_keys SET revoked_at = now() WHERE tenant_id = ${tid(c)} AND id = ${param(c, "id")} AND revoked_at IS NULL RETURNING id`;
      if (!rows.length) throw notFound("key");
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ settings
  const readSettings = async (tenantId: string): Promise<TenantSettings> => {
    const [t] = await sql<{ retention_days: number | null; daily_token_budget: number | null }[]>`
      SELECT retention_days, daily_token_budget FROM tenants WHERE id = ${tenantId}`;
    return { retentionDays: t?.retention_days ?? null, dailyTokenBudget: t?.daily_token_budget ?? null };
  };
  route(app, { method: "get", path: "/v1/admin/settings", tag: A, summary: "Tenant settings", auth: "admin", response: { status: 200, schema: TenantSettings } },
    async (c) => c.json(await readSettings(tid(c))));

  route(app, { method: "patch", path: "/v1/admin/settings", tag: A, summary: "Update tenant settings", auth: "admin", body: TenantSettingsPatch, response: { status: 200, schema: TenantSettings } },
    async (c, { body }) => {
      const cur = await readSettings(tid(c));
      await sql`UPDATE tenants SET
        retention_days = ${body.retentionDays !== undefined ? body.retentionDays : cur.retentionDays},
        daily_token_budget = ${body.dailyTokenBudget !== undefined ? body.dailyTokenBudget : cur.dailyTokenBudget}
        WHERE id = ${tid(c)}`;
      return c.json(await readSettings(tid(c)));
    });

  // ----------------------------------------------------------------- audit log
  const AuditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().max(64).optional(),
    action: z.string().max(100).optional(),
    targetId: z.string().max(200).optional(),
    actorId: z.string().max(64).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  });
  route(app, {
      method: "get", path: "/v1/admin/audit-log", tag: A, summary: "Audit log of admin changes",
      description: "Newest first. `action` matches exactly (`widgets.update`) or by resource (`widgets`). Entries cannot be changed or deleted through the API.",
      auth: "admin", query: AuditQuery, response: { status: 200, schema: AuditEventList },
    },
    async (c, { query }) => {
      const page = await listAudit(sql, tid(c), query);
      return c.json({ items: page.items.map(toAuditEvent), nextCursor: page.nextCursor });
    });

  // ------------------------------------------------------- privacy and export
  route(app, { method: "delete", path: "/v1/admin/conversations/{id}", tag: A, summary: "Delete a conversation permanently", auth: "admin", response: { status: 204 } },
    async (c) => {
      const rows = await sql`DELETE FROM conversations WHERE tenant_id = ${tid(c)} AND id = ${param(c, "id")} RETURNING id`;
      if (!rows.length) throw notFound("conversation");
      return c.body(null, 204);
    });

  route(app, {
      method: "delete", path: "/v1/admin/subjects/{subjectId}", tag: A, summary: "Erase all data of one visitor or user",
      description: "Right to erasure: deletes every conversation of the subject (e.g. `user:123` or `anon:...`) across all widgets.",
      auth: "admin", response: { status: 200, schema: z.object({ deletedConversations: z.number().int() }) },
    },
    async (c) => {
      const rows = await sql`DELETE FROM conversations WHERE tenant_id = ${tid(c)} AND subject_id = ${param(c, "subjectId")} RETURNING id`;
      return c.json({ deletedConversations: rows.length });
    });

  route(app, {
      method: "get", path: "/v1/admin/conversations/export", tag: A, summary: "Export conversations (NDJSON)",
      description: "One JSON object per line: the conversation with all its messages. Covers conversations updated in the last `days` days.",
      auth: "admin", query: Days, response: { status: 200, description: "application/x-ndjson", contentType: "application/x-ndjson" },
    },
    async (c, { query }) => {
      const tenantId = tid(c);
      const since = new Date(Date.now() - query.days * 86400_000);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const cursor = sql<{ id: string; widget_id: string; assistant_id: string; subject_id: string; subject_kind: string; title: string | null; handoff_at: Date | null; created_at: Date; updated_at: Date }[]>`
              SELECT id, widget_id, assistant_id, subject_id, subject_kind, title, handoff_at, created_at, updated_at
              FROM conversations WHERE tenant_id = ${tenantId} AND updated_at >= ${since} ORDER BY updated_at DESC`.cursor(50);
            for await (const batch of cursor) {
              const ids = batch.map((b) => b.id);
              const msgs = await sql<{ conversation_id: string; id: string; role: string; content: string; citations: unknown; feedback: string | null; feedback_comment: string | null; tool_calls: unknown; status: string; created_at: Date }[]>`
                SELECT conversation_id, id, role, content, citations, feedback, feedback_comment, tool_calls, status, created_at
                FROM messages WHERE tenant_id = ${tenantId} AND conversation_id = ANY(${sql.array(ids)}) ORDER BY created_at, id`;
              const byConv = new Map<string, unknown[]>();
              for (const m of msgs) {
                const list = byConv.get(m.conversation_id) ?? [];
                list.push({ id: m.id, role: m.role, content: m.content, citations: m.citations, feedback: m.feedback, feedbackComment: m.feedback_comment, tools: m.tool_calls, status: m.status, createdAt: iso(m.created_at) });
                byConv.set(m.conversation_id, list);
              }
              for (const b of batch) {
                const line = { id: b.id, widgetId: b.widget_id, assistantId: b.assistant_id, subjectId: b.subject_id, subjectKind: b.subject_kind, title: b.title, handoffRequestedAt: isoOrNull(b.handoff_at), createdAt: iso(b.created_at), updatedAt: iso(b.updated_at), messages: byConv.get(b.id) ?? [] };
                controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
              }
            }
            controller.close();
          } catch (err) {
            s.log.error({ err }, "export failed");
            controller.error(err);
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="conversations-${new Date().toISOString().slice(0, 10)}.ndjson"`,
          "cache-control": "no-store",
        },
      });
    });

  // ------------------------------------------------------------------ insights
  route(app, {
      method: "get", path: "/v1/admin/insights", tag: A, summary: "Answer quality and knowledge gaps",
      description: "What visitors ask, what the knowledge base could not answer, handoffs, satisfaction and tool usage.",
      auth: "admin", query: Days, response: { status: 200, schema: Insights },
    },
    async (c, { query }) => {
      const tenantId = tid(c);
      const to = new Date();
      const from = new Date(to.getTime() - query.days * 86400_000);
      const norm = sql`lower(regexp_replace(btrim(m.content), '\\s+', ' ', 'g'))`;
      const [counts, top, gaps, down, tools, guards] = await Promise.all([
        sql<{ conversations: string; questions: string; unanswered: string; handoffs: string; up: string; down: string }[]>`
          SELECT
            (SELECT count(*) FROM conversations WHERE tenant_id = ${tenantId} AND created_at >= ${from}) AS conversations,
            (SELECT count(*) FROM runs WHERE tenant_id = ${tenantId} AND created_at >= ${from}) AS questions,
            (SELECT count(*) FROM runs WHERE tenant_id = ${tenantId} AND created_at >= ${from} AND source_count = 0 AND guardrail IS NULL) AS unanswered,
            (SELECT count(*) FROM conversations WHERE tenant_id = ${tenantId} AND handoff_at >= ${from}) AS handoffs,
            (SELECT count(*) FROM messages WHERE tenant_id = ${tenantId} AND created_at >= ${from} AND feedback = 'up') AS up,
            (SELECT count(*) FROM messages WHERE tenant_id = ${tenantId} AND created_at >= ${from} AND feedback = 'down') AS down`,
        sql<{ question: string; count: string; last: Date }[]>`
          SELECT min(m.content) AS question, count(*) AS count, max(m.created_at) AS last
          FROM messages m WHERE m.tenant_id = ${tenantId} AND m.role = 'user' AND m.created_at >= ${from}
          GROUP BY ${norm} ORDER BY count(*) DESC, max(m.created_at) DESC LIMIT 20`,
        sql<{ question: string; count: string; last: Date }[]>`
          SELECT min(m.content) AS question, count(*) AS count, max(m.created_at) AS last
          FROM runs r JOIN messages m ON m.id = r.user_message_id
          WHERE r.tenant_id = ${tenantId} AND r.created_at >= ${from} AND r.source_count = 0 AND r.guardrail IS NULL
          GROUP BY ${norm} ORDER BY count(*) DESC, max(m.created_at) DESC LIMIT 20`,
        sql<{ conversation_id: string; id: string; answer: string; comment: string | null; created_at: Date; question: string | null }[]>`
          SELECT a.conversation_id, a.id, a.content AS answer, a.feedback_comment AS comment, a.created_at,
            (SELECT q.content FROM messages q WHERE q.conversation_id = a.conversation_id AND q.role = 'user'
               AND (q.created_at, q.id) < (a.created_at, a.id) ORDER BY q.created_at DESC, q.id DESC LIMIT 1) AS question
          FROM messages a WHERE a.tenant_id = ${tenantId} AND a.feedback = 'down' AND a.created_at >= ${from}
          ORDER BY a.created_at DESC LIMIT 20`,
        sql<{ name: string; calls: string; errors: string }[]>`
          SELECT t->>'name' AS name, count(*) AS calls, count(*) FILTER (WHERE (t->>'isError')::boolean) AS errors
          FROM messages m, jsonb_array_elements(m.tool_calls) t
          WHERE m.tenant_id = ${tenantId} AND m.created_at >= ${from} AND jsonb_array_length(m.tool_calls) > 0
          GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
        sql<{ kind: GuardrailKind; count: string }[]>`
          SELECT guardrail AS kind, count(*) AS count FROM runs
          WHERE tenant_id = ${tenantId} AND created_at >= ${from} AND guardrail IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
      ]);
      const k = counts[0]!;
      const up = Number(k.up);
      const dn = Number(k.down);
      const body: Insights = {
        from: from.toISOString(),
        to: to.toISOString(),
        conversations: Number(k.conversations),
        questions: Number(k.questions),
        unanswered: Number(k.unanswered),
        handoffs: Number(k.handoffs),
        feedbackUp: up,
        feedbackDown: dn,
        satisfaction: up + dn ? up / (up + dn) : null,
        topQuestions: top.map((r) => ({ question: r.question, count: Number(r.count), lastAskedAt: iso(r.last) })),
        knowledgeGaps: gaps.map((r) => ({ question: r.question, count: Number(r.count), lastAskedAt: iso(r.last) })),
        downvoted: down.map((r) => ({ conversationId: r.conversation_id, messageId: r.id, question: r.question ?? "", answer: r.answer, comment: r.comment, createdAt: iso(r.created_at) })),
        tools: tools.map((r) => ({ name: r.name, calls: Number(r.calls), errors: Number(r.errors) })),
        guardrails: guards.map((r) => ({ kind: r.kind, count: Number(r.count) })),
      };
      return c.json(body);
    });

}
