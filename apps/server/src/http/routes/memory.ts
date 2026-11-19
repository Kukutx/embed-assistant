/** Long-term memory: signed-in users see and erase what the assistant remembers; admins can review it per subject. */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { MemoryList } from "@embed-assistant/protocol";
import { deleteAllMemories, deleteMemory, listMemories, toMemory } from "../../memory/memories.js";
import { notFound } from "../../lib/errors.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

export function memoryRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  /** Memories belong to signed-in users; anonymous visitors have none. */
  const userOf = (c: Context<AppEnv>) => {
    const sess = c.get("session");
    return sess.subjectKind === "user" ? { tenantId: sess.tenantId, subjectId: sess.subjectId } : null;
  };

  route(app, {
      method: "get", path: "/v1/memories", tag: "Chat", summary: "What the assistant remembers about the signed-in user",
      description: "Facts the user shared that assistants with `memory` enabled keep across conversations (most recent first). Always empty for anonymous visitors.",
      auth: "session", response: { status: 200, schema: MemoryList },
    },
    async (c) => {
      const u = userOf(c);
      return c.json({ items: u ? (await listMemories(sql, u.tenantId, u.subjectId)).map(toMemory) : [] });
    });

  route(app, { method: "delete", path: "/v1/memories/{id}", tag: "Chat", summary: "Forget one fact", auth: "session", response: { status: 204, description: "Deleted" } },
    async (c) => {
      const u = userOf(c);
      if (!u || !(await deleteMemory(sql, u.tenantId, u.subjectId, param(c, "id")))) throw notFound("memory");
      return c.body(null, 204);
    });

  route(app, { method: "delete", path: "/v1/memories", tag: "Chat", summary: "Forget everything about the signed-in user", auth: "session", response: { status: 204, description: "Deleted" } },
    async (c) => {
      const u = userOf(c);
      if (u) await deleteAllMemories(sql, u.tenantId, u.subjectId);
      return c.body(null, 204);
    });

  route(app, {
      method: "get", path: "/v1/admin/subjects/{subjectId}/memories", tag: "Admin", summary: "What assistants remember about one user",
      description: "For access requests and support. Erasing the subject (`DELETE /v1/admin/subjects/{subjectId}`) deletes these too.",
      auth: "admin", response: { status: 200, schema: MemoryList },
    },
    async (c) => c.json({ items: (await listMemories(sql, c.get("tenantId"), param(c, "subjectId"))).map(toMemory) }));

  route(app, {
      method: "delete", path: "/v1/admin/subjects/{subjectId}/memories", tag: "Admin", summary: "Delete what assistants remember about one user",
      auth: "admin", response: { status: 200, schema: z.object({ deleted: z.number().int() }) },
    },
    async (c) => c.json({ deleted: await deleteAllMemories(sql, c.get("tenantId"), param(c, "subjectId")) }));
}
