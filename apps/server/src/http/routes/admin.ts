import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AdminConversation,
  Assistant,
  AssistantInput,
  AssistantPatch,
  AssistantVersionDetail,
  AssistantVersionList,
  DocumentInput,
  KnowledgeDocument,
  KnowledgeSource,
  KnowledgeSourceInput,
  KnowledgeSourcePatch,
  FileUploadResult,
  HandoffState,
  MessageList,
  ModelAliasInfo,
  RestoreVersionInput,
  RunTraceList,
  UsageSummary,
  Widget,
  WidgetInput,
  WidgetPatch,
  WidgetSecret,
} from "@embed-assistant/protocol";
import { getVersion, listVersions } from "../../assistants/versions.js";
import { conversationTraces } from "../../runs/trace.js";
import {
  adminGetConversation,
  adminListConversations,
  createAssistant,
  createSource,
  createWidget,
  deleteAssistant,
  deleteDocument,
  deleteSource,
  deleteWidget,
  getAssistant,
  getSource,
  getWidget,
  listAssistants,
  listDocuments,
  listMessages,
  listSources,
  listWidgets,
  setSourceStatus,
  setWidgetSecret,
  toAssistant,
  toMessage,
  toSource,
  toWidget,
  updateAssistant,
  updateWidget,
  updateSource,
} from "../../db/store.js";
import { enqueueJob } from "../../knowledge/jobs.js";
import { upsertDocument } from "../../knowledge/ingest.js";
import { extractDocument, UnsupportedDocumentError } from "../../knowledge/extract.js";
import { encrypt } from "../../lib/crypto.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { randomToken } from "../../lib/ids.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";
import type { WidgetCache } from "../middleware.js";

const tid = (c: Context<AppEnv>) => c.get("tenantId");

const CreatedWidget = z.object({ widget: Widget, identitySecret: z.string(), embedSnippet: z.string() });
const Snippet = z.object({ html: z.string() });
const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });
const AdminPage = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});
const DocPage = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function adminRoutes(app: Hono<AppEnv>, s: Services, widgets: WidgetCache): void {
  const { sql } = s;
  const A = "Admin";

  async function validateAssistantRefs(tenantId: string, input: { modelAlias?: string; sourceIds?: string[]; actionIds?: string[]; mcpServerIds?: string[]; playbookIds?: string[] }) {
    if (input.playbookIds?.length) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM playbooks WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.playbookIds)})`;
      const found = new Set(rows.map((r) => r.id));
      const missing = input.playbookIds.filter((id) => !found.has(id));
      if (missing.length) throw badRequest("unknown playbooks", { missing });
    }
    if (input.mcpServerIds?.length) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM mcp_servers WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.mcpServerIds)})`;
      const found = new Set(rows.map((r) => r.id));
      const missing = input.mcpServerIds.filter((id) => !found.has(id));
      if (missing.length) throw badRequest("unknown MCP servers", { missing });
    }
    if (input.actionIds?.length) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM actions WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.actionIds)})`;
      const found = new Set(rows.map((r) => r.id));
      const missing = input.actionIds.filter((id) => !found.has(id));
      if (missing.length) throw badRequest("unknown actions", { missing });
    }
    if (input.modelAlias !== undefined && !s.models.hasAlias(input.modelAlias)) {
      throw badRequest(`unknown model alias "${input.modelAlias}"`, { aliases: s.models.describe().map((m) => m.alias) });
    }
    if (input.sourceIds?.length) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM knowledge_sources WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.sourceIds)})`;
      const found = new Set(rows.map((r) => r.id));
      const missing = input.sourceIds.filter((id) => !found.has(id));
      if (missing.length) throw badRequest("unknown knowledge sources", { missing });
    }
  }

  const newSecret = () => `ea_whs_${randomToken(32)}`;
  const snippet = (widgetId: string) =>
    `<script src="${s.cfg.PUBLIC_BASE_URL}/widget/loader.js" data-widget-id="${widgetId}" async></script>`;

  // ---------------------------------------------------------------- assistants
  route(app, { method: "get", path: "/v1/admin/assistants", tag: A, summary: "List assistants", auth: "admin", response: { status: 200, schema: z.array(Assistant) } },
    async (c) => c.json((await listAssistants(sql, tid(c))).map(toAssistant)));

  route(app, { method: "post", path: "/v1/admin/assistants", tag: A, summary: "Create an assistant", auth: "admin", body: AssistantInput, response: { status: 201, schema: Assistant } },
    async (c, { body }) => {
      await validateAssistantRefs(tid(c), body);
      return c.json(toAssistant(await createAssistant(sql, tid(c), body, { by: actorName(c), note: body.changeNote })), 201);
    });

  route(app, { method: "get", path: "/v1/admin/assistants/{id}", tag: A, summary: "Get an assistant", auth: "admin", response: { status: 200, schema: Assistant } },
    async (c) => {
      const a = await getAssistant(sql, tid(c), param(c, "id"));
      if (!a) throw notFound("assistant");
      return c.json(toAssistant(a));
    });

  route(app, { method: "patch", path: "/v1/admin/assistants/{id}", tag: A, summary: "Update an assistant", auth: "admin", body: AssistantPatch, response: { status: 200, schema: Assistant } },
    async (c, { body }) => {
      await validateAssistantRefs(tid(c), body);
      const { changeNote, ...patch } = body;
      const a = await updateAssistant(sql, tid(c), param(c, "id"), stripUndefined(patch), { by: actorName(c), note: changeNote });
      if (!a) throw notFound("assistant");
      return c.json(toAssistant(a));
    });

  route(app, {
      method: "get", path: "/v1/admin/assistants/{id}/versions", tag: A, summary: "Version history of an assistant (newest first)",
      description: "Every saved configuration, who saved it, the note given, and which fields changed.",
      auth: "admin", response: { status: 200, schema: AssistantVersionList },
    },
    async (c) => {
      const a = await getAssistant(sql, tid(c), param(c, "id"));
      if (!a) throw notFound("assistant");
      return c.json({ items: await listVersions(sql, tid(c), a.id) });
    });

  route(app, { method: "get", path: "/v1/admin/assistants/{id}/versions/{version}", tag: A, summary: "One saved configuration", auth: "admin", response: { status: 200, schema: AssistantVersionDetail } },
    async (c) => {
      const v = await getVersion(sql, tid(c), param(c, "id"), Number.parseInt(param(c, "version"), 10) || 0);
      if (!v) throw notFound("version");
      return c.json(v);
    });

  route(app, {
      method: "post", path: "/v1/admin/assistants/{id}/versions/{version}/restore", tag: A, summary: "Restore a saved configuration",
      description: "Saves it as a new version (history is never rewritten). Knowledge sources, actions and MCP servers deleted since are left out.",
      auth: "admin", body: RestoreVersionInput, response: { status: 200, schema: Assistant },
    },
    async (c, { body }) => {
      const n = Number.parseInt(param(c, "version"), 10) || 0;
      const v = await getVersion(sql, tid(c), param(c, "id"), n);
      if (!v) throw notFound("version");
      const cfg = v.config;
      if (!s.models.hasAlias(cfg.modelAlias)) {
        throw badRequest(`version ${n} uses the model alias "${cfg.modelAlias}", which is no longer configured`, { aliases: s.models.describe().map((m) => m.alias) });
      }
      const existing = async (table: "knowledge_sources" | "actions" | "mcp_servers" | "playbooks", ids: string[]) =>
        ids.length ? new Set((await sql<{ id: string }[]>`SELECT id FROM ${sql(table)} WHERE tenant_id = ${tid(c)} AND id = ANY(${sql.array(ids)})`).map((r) => r.id)) : new Set<string>();
      const [srcs, acts, mcps, pbks] = await Promise.all([
        existing("knowledge_sources", cfg.sourceIds), existing("actions", cfg.actionIds), existing("mcp_servers", cfg.mcpServerIds), existing("playbooks", cfg.playbookIds),
      ]);
      const next = {
        ...cfg,
        sourceIds: cfg.sourceIds.filter((x) => srcs.has(x)),
        actionIds: cfg.actionIds.filter((x) => acts.has(x)),
        mcpServerIds: cfg.mcpServerIds.filter((x) => mcps.has(x)),
        playbookIds: cfg.playbookIds.filter((x) => pbks.has(x)),
      };
      const count = (x: typeof cfg) => x.sourceIds.length + x.actionIds.length + x.mcpServerIds.length + x.playbookIds.length;
      const dropped = count(cfg) - count(next);
      const note = body.note ?? `Restored version ${n}${dropped ? ` (left out ${dropped} deleted reference${dropped > 1 ? "s" : ""})` : ""}`;
      const a = await updateAssistant(sql, tid(c), param(c, "id"), next, { by: actorName(c), note });
      if (!a) throw notFound("assistant");
      return c.json(toAssistant(a));
    });

  route(app, { method: "delete", path: "/v1/admin/assistants/{id}", tag: A, summary: "Delete an assistant (and its widgets and evaluation suites)", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteAssistant(sql, tid(c), param(c, "id")))) throw notFound("assistant");
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------- widgets
  route(app, { method: "get", path: "/v1/admin/widgets", tag: A, summary: "List widgets", auth: "admin", response: { status: 200, schema: z.array(Widget) } },
    async (c) => c.json((await listWidgets(sql, tid(c))).map(toWidget)));

  route(app, {
      method: "post", path: "/v1/admin/widgets", tag: A, summary: "Create a widget",
      description: "Returns the identity secret ONCE. Keep it on your backend; it signs user tokens.",
      auth: "admin", body: WidgetInput, response: { status: 201, schema: CreatedWidget },
    },
    async (c, { body }) => {
      if (!(await getAssistant(sql, tid(c), body.assistantId))) throw badRequest("unknown assistantId");
      const secret = newSecret();
      const w = await createWidget(sql, tid(c), body, encrypt(s.secretsKey, secret));
      return c.json({ widget: toWidget(w), identitySecret: secret, embedSnippet: snippet(w.id) }, 201);
    });

  route(app, { method: "get", path: "/v1/admin/widgets/{id}", tag: A, summary: "Get a widget", auth: "admin", response: { status: 200, schema: Widget } },
    async (c) => {
      const w = await getWidget(sql, tid(c), param(c, "id"));
      if (!w) throw notFound("widget");
      return c.json(toWidget(w));
    });

  route(app, { method: "get", path: "/v1/admin/widgets/{id}/snippet", tag: A, summary: "Embed snippet for a widget", auth: "admin", response: { status: 200, schema: Snippet } },
    async (c) => {
      const w = await getWidget(sql, tid(c), param(c, "id"));
      if (!w) throw notFound("widget");
      return c.json({ html: snippet(w.id) });
    });

  route(app, { method: "patch", path: "/v1/admin/widgets/{id}", tag: A, summary: "Update a widget", auth: "admin", body: WidgetPatch, response: { status: 200, schema: Widget } },
    async (c, { body }) => {
      if (body.assistantId && !(await getAssistant(sql, tid(c), body.assistantId))) throw badRequest("unknown assistantId");
      const w = await updateWidget(sql, tid(c), param(c, "id"), stripUndefined(body));
      if (!w) throw notFound("widget");
      widgets.invalidate(w.id);
      return c.json(toWidget(w));
    });

  route(app, { method: "post", path: "/v1/admin/widgets/{id}/rotate-secret", tag: A, summary: "Rotate the identity secret", description: "Existing user tokens stop working immediately.", auth: "admin", response: { status: 200, schema: WidgetSecret } },
    async (c) => {
      const secret = newSecret();
      if (!(await setWidgetSecret(sql, tid(c), param(c, "id"), encrypt(s.secretsKey, secret)))) throw notFound("widget");
      widgets.invalidate(param(c, "id"));
      return c.json({ widgetId: param(c, "id"), identitySecret: secret });
    });

  route(app, { method: "delete", path: "/v1/admin/widgets/{id}", tag: A, summary: "Delete a widget", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteWidget(sql, tid(c), param(c, "id")))) throw notFound("widget");
      widgets.invalidate(param(c, "id"));
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ knowledge
  route(app, { method: "get", path: "/v1/admin/sources", tag: A, summary: "List knowledge sources", auth: "admin", response: { status: 200, schema: z.array(KnowledgeSource) } },
    async (c) => c.json((await listSources(sql, tid(c))).map(toSource)));

  route(app, {
      method: "post", path: "/v1/admin/sources", tag: A, summary: "Create a knowledge source",
      description:
        "url and sitemap sources are crawled in the background right away (a sitemap URL ending in /llms.txt is read as an llms.txt index). " +
        "manual sources are filled with PUT .../documents or by uploading files.",
      auth: "admin", body: KnowledgeSourceInput, response: { status: 201, schema: KnowledgeSource },
    },
    async (c, { body }) => {
      const src = await createSource(sql, tid(c), body);
      if (src.type !== "manual") {
        await setSourceStatus(sql, tid(c), src.id, "queued");
        await enqueueJob(sql, tid(c), "ingest_source", { sourceId: src.id });
        src.status = "queued";
      }
      return c.json(toSource(src), 201);
    });

  route(app, { method: "get", path: "/v1/admin/sources/{id}", tag: A, summary: "Get a knowledge source", auth: "admin", response: { status: 200, schema: KnowledgeSource } },
    async (c) => {
      const src = await getSource(sql, tid(c), param(c, "id"));
      if (!src) throw notFound("source");
      return c.json(toSource(src));
    });

  route(app, { method: "post", path: "/v1/admin/sources/{id}/sync", tag: A, summary: "Re-crawl a source now", auth: "admin", response: { status: 202, schema: KnowledgeSource } },
    async (c) => {
      const src = await getSource(sql, tid(c), param(c, "id"));
      if (!src) throw notFound("source");
      if (src.type === "manual") throw badRequest("manual sources are updated with PUT /documents");
      if (src.status !== "queued" && src.status !== "running") {
        await setSourceStatus(sql, tid(c), src.id, "queued");
        await enqueueJob(sql, tid(c), "ingest_source", { sourceId: src.id });
        src.status = "queued";
      }
      return c.json(toSource(src), 202);
    });

  route(app, { method: "patch", path: "/v1/admin/sources/{id}", tag: A, summary: "Update a knowledge source", auth: "admin", body: KnowledgeSourcePatch, response: { status: 200, schema: KnowledgeSource } },
    async (c, { body }) => {
      const src = await updateSource(sql, tid(c), param(c, "id"), Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      if (!src) throw notFound("source");
      return c.json(toSource(src));
    });

  route(app, {
      method: "post", path: "/v1/admin/sources/{id}/files", tag: A, summary: "Upload files to a manual source",
      description:
        "multipart/form-data with one or more `file` fields (PDF, DOCX, HTML, Markdown, plain text; up to 20 MB each, 25 files per request). " +
        "Uploading a file with the same name replaces the earlier version.",
      auth: "admin", response: { status: 200, schema: FileUploadResult },
    },
    async (c) => {
      const src = await getSource(sql, tid(c), param(c, "id"));
      if (!src) throw notFound("source");
      if (src.type !== "manual") throw badRequest("files can only be added to manual sources (crawled sources would remove them on the next sync)");
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        throw badRequest("expected multipart/form-data");
      }
      const files = ([] as (string | File)[]).concat(form.file ?? form["file[]"] ?? []).filter((f): f is File => typeof f !== "string");
      if (!files.length) throw badRequest("no files: send them as multipart/form-data fields named \"file\"");
      if (files.length > 25) throw badRequest("at most 25 files per request");
      const results = [];
      for (const f of files) {
        const name = (f.name || "upload").replace(/[\\/]+/g, "_").slice(0, 200);
        try {
          if (f.size > 20 * 1024 * 1024) throw new UnsupportedDocumentError("file larger than 20 MB");
          const doc = await extractDocument(Buffer.from(await f.arrayBuffer()), { contentType: f.type, name });
          if (!doc.text.trim()) throw new UnsupportedDocumentError("no text found");
          const r = await upsertDocument(s.ingest, src, { externalId: `file:${name}`, title: doc.title, url: null, content: doc.text });
          results.push({ name, documentId: r.id, title: doc.title, changed: r.changed, error: null });
        } catch (err) {
          if (!(err instanceof UnsupportedDocumentError)) s.log.warn({ err, file: name }, "file ingest failed");
          results.push({ name, documentId: null, title: null, changed: false, error: err instanceof UnsupportedDocumentError ? err.message : "could not read this file" });
        }
      }
      if (results.some((x) => x.documentId)) await setSourceStatus(sql, tid(c), src.id, "succeeded");
      return c.json({ results });
    });

  route(app, { method: "delete", path: "/v1/admin/sources/{id}", tag: A, summary: "Delete a source and all its documents", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteSource(sql, tid(c), param(c, "id")))) throw notFound("source");
      await sql`UPDATE assistants SET source_ids = array_remove(source_ids, ${param(c, "id")}) WHERE tenant_id = ${tid(c)}`;
      return c.body(null, 204);
    });

  route(app, { method: "get", path: "/v1/admin/sources/{id}/documents", tag: A, summary: "List documents of a source", auth: "admin", query: DocPage, response: { status: 200, schema: z.array(KnowledgeDocument) } },
    async (c, { query }) => {
      if (!(await getSource(sql, tid(c), param(c, "id")))) throw notFound("source");
      return c.json(await listDocuments(sql, tid(c), param(c, "id"), query.limit, query.offset));
    });

  route(app, {
      method: "put", path: "/v1/admin/sources/{id}/documents", tag: A, summary: "Upsert a document",
      description: "Push content from any system (CMS, ticketing, docs build). Same externalId replaces; unchanged content is a no-op.",
      auth: "admin", body: DocumentInput, response: { status: 200, schema: z.object({ id: z.string(), changed: z.boolean() }) },
    },
    async (c, { body }) => {
      const src = await getSource(sql, tid(c), param(c, "id"));
      if (!src) throw notFound("source");
      const result = await upsertDocument(s.ingest, src, {
        externalId: body.externalId ?? body.url ?? body.title,
        title: body.title,
        url: body.url,
        content: body.content,
      });
      if (src.type === "manual") await setSourceStatus(sql, tid(c), src.id, "succeeded");
      return c.json(result);
    });

  route(app, { method: "delete", path: "/v1/admin/sources/{id}/documents/{docId}", tag: A, summary: "Delete a document", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteDocument(sql, tid(c), param(c, "id"), param(c, "docId")))) throw notFound("document");
      return c.body(null, 204);
    });

  // ------------------------------------------------------------- conversations
  const ConversationQuery = AdminPage.extend({
    handoff: HandoffState.optional(),
    /** `me`, or a console user id. */
    assignee: z.string().max(64).optional(),
  });
  route(app, {
      method: "get", path: "/v1/admin/conversations", tag: A, summary: "Browse conversations",
      description: "Most recently active first. `handoff` filters the human inbox: `waiting` (handoff requested, nobody joined), `active` (a person is handling it), `resolved`, `any`.",
      auth: "admin", query: ConversationQuery, response: { status: 200, schema: z.object({ items: z.array(AdminConversation), nextCursor: z.string().nullable() }) },
    },
    async (c, { query }) => {
      const assigneeId = query.assignee === "me" ? c.get("actor").id : query.assignee;
      const rows = await adminListConversations(sql, tid(c), query.limit + 1, query.cursor ?? null, { handoff: query.handoff, assigneeId });
      const items = rows.slice(0, query.limit);
      return c.json({ items, nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null });
    });

  route(app, { method: "get", path: "/v1/admin/conversations/{id}/messages", tag: A, summary: "Read a conversation", auth: "admin", query: AdminPage, response: { status: 200, schema: MessageList } },
    async (c, { query }) => {
      const conv = await adminGetConversation(sql, tid(c), param(c, "id"));
      if (!conv) throw notFound("conversation");
      const rows = await listMessages(sql, tid(c), conv.id, query.limit + 1, query.cursor ?? null);
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(1) : rows;
      return c.json({ items: items.map(toMessage), nextCursor: hasMore ? (items[0]?.id ?? null) : null });
    });

  route(app, {
      method: "get", path: "/v1/admin/conversations/{id}/runs", tag: A, summary: "Inspect how each answer was produced",
      description: "One trace per answer (the latest 100): passages given to the model, tools called and how long they took, tokens, model deployment, assistant version, guardrail and errors, and a timeline of events.",
      auth: "admin", response: { status: 200, schema: RunTraceList },
    },
    async (c) => {
      const conv = await adminGetConversation(sql, tid(c), param(c, "id"));
      if (!conv) throw notFound("conversation");
      return c.json({ items: await conversationTraces(sql, tid(c), conv.id) });
    });

  // ---------------------------------------------------------- models and usage
  route(app, { method: "get", path: "/v1/admin/models", tag: A, summary: "Model aliases and deployments", auth: "admin", response: { status: 200, schema: z.array(ModelAliasInfo) } },
    (c) => c.json(s.models.describe()));

  route(app, { method: "get", path: "/v1/admin/usage", tag: A, summary: "Usage and quality summary", auth: "admin", query: UsageQuery, response: { status: 200, schema: UsageSummary } },
    async (c, { query }) => {
      const to = new Date();
      const from = new Date(to.getTime() - query.days * 86400_000);
      const [r] = await sql<{ runs: string; failed: string; inp: string | null; out: string | null; p50: number | null; p95: number | null }[]>`
        SELECT count(*) AS runs,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               sum(input_tokens) AS inp, sum(output_tokens) AS out,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS p95
        FROM runs WHERE tenant_id = ${tid(c)} AND created_at >= ${from}`;
      const [f] = await sql<{ up: string; down: string }[]>`
        SELECT count(*) FILTER (WHERE feedback = 'up') AS up, count(*) FILTER (WHERE feedback = 'down') AS down
        FROM messages WHERE tenant_id = ${tid(c)} AND created_at >= ${from}`;
      const body: UsageSummary = {
        from: from.toISOString(),
        to: to.toISOString(),
        runs: Number(r?.runs ?? 0),
        failedRuns: Number(r?.failed ?? 0),
        inputTokens: Number(r?.inp ?? 0),
        outputTokens: Number(r?.out ?? 0),
        feedbackUp: Number(f?.up ?? 0),
        feedbackDown: Number(f?.down ?? 0),
        p50FirstTokenMs: r?.p50 ?? null,
        p95FirstTokenMs: r?.p95 ?? null,
      };
      return c.json(body);
    });
}

function actorName(c: Context<AppEnv>): string | null {
  const a = c.get("actor");
  return a ? (a.name ?? a.email ?? a.id) : null;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
