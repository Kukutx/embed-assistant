/** Knowledge search without an answer: for a help-center search box, or to test what the assistant would find. */
import type { Hono } from "hono";
import { z } from "zod";
import { SearchRequest, SearchResponse } from "@embed-assistant/protocol";
import { getAssistant } from "../../db/store.js";
import { retrieve } from "../../knowledge/retrieve.js";
import { notFound } from "../../lib/errors.js";
import { redactPii } from "../../lib/pii.js";
import { toCitation } from "../../runs/prompt.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

const AdminSearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  /** Comma-separated access groups of the simulated visitor (default: public only). */
  access: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export function searchRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;

  route(app, {
      method: "post", path: "/v1/search", tag: "Chat", summary: "Search the knowledge (no AI answer)",
      description:
        "Returns the passages the assistant would read for this query, best first, from the knowledge this visitor may read. " +
        "No model is called (unless embeddings are configured), so it is fast and cheap: use it for a search box or to suggest " +
        "articles before a contact form. Queries are counted in Insights.",
      auth: "session", body: SearchRequest, response: { status: 200, schema: SearchResponse },
    },
    async (c, { body }) => {
      const sess = c.get("session");
      const widget = c.get("widget");
      await s.limiter.hit(`search:sub:${sess.widgetId}:${sess.subjectId}`, 60, 60);
      await s.limiter.hit(`search:ip:${c.get("clientIp")}`, 600, 3600);
      const assistant = await getAssistant(sql, widget.tenant_id, widget.assistant_id);
      if (!assistant) throw notFound("assistant");
      const passages = await retrieve(sql, s.models.embeddings, s.log, {
        tenantId: widget.tenant_id,
        sourceIds: assistant.source_ids,
        access: sess.access,
        query: body.query,
        limit: body.limit,
      });
      const query = assistant.redact_pii ? redactPii(body.query) : body.query;
      void sql`INSERT INTO searches (tenant_id, widget_id, assistant_id, query, result_count)
               VALUES (${widget.tenant_id}, ${widget.id}, ${assistant.id}, ${query.slice(0, 500)}, ${passages.length})`.catch((err: unknown) =>
        s.log.warn({ err }, "could not record search"),
      );
      const res: SearchResponse = { results: passages.slice(0, body.limit ?? 5).map(toCitation) };
      return c.json(res);
    });

  route(app, {
      method: "get", path: "/v1/admin/assistants/{id}/search", tag: "Admin", summary: "Test what the assistant finds for a query",
      description: "The passages retrieval returns for `q`, as a visitor with the given access groups would get them (not recorded in Insights).",
      auth: "admin", query: AdminSearchQuery, response: { status: 200, schema: SearchResponse },
    },
    async (c, { query }) => {
      const assistant = await getAssistant(sql, c.get("tenantId"), param(c, "id"));
      if (!assistant) throw notFound("assistant");
      const groups = (query.access ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const passages = await retrieve(sql, s.models.embeddings, s.log, {
        tenantId: assistant.tenant_id,
        sourceIds: assistant.source_ids,
        access: ["public", ...groups],
        query: query.q,
        limit: query.limit,
      });
      return c.json({ results: passages.slice(0, query.limit).map(toCitation) });
    });
}
