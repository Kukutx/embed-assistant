/**
 * Long-term memory for signed-in users: short facts the assistant was told
 * (preferences, the product or plan they use) kept across conversations.
 * Opt-in per assistant, never for anonymous visitors, visible to and erasable
 * by the user, removed by subject erasure and by the retention period.
 */
import type { Memory } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { redactPii } from "../lib/pii.js";
import { iso } from "../lib/time.js";
import type { ToolDef } from "../models/types.js";
import type { RunTool } from "../runs/tools.js";

/** Kept per user; the least recently confirmed are dropped beyond this. */
export const MAX_MEMORIES = 50;
export const MAX_MEMORY_CHARS = 300;
export const REMEMBER_TOOL = "remember";
export const FORGET_TOOL = "forget";

export interface MemoryRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  content: string;
  conversation_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
}

export const toMemory = (r: MemoryRow): Memory => ({ id: r.id, content: r.content, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

/** Most recent first. */
export function listMemories(sql: Sql, tenantId: string, subjectId: string, limit = MAX_MEMORIES): Promise<MemoryRow[]> {
  return sql<MemoryRow[]>`
    SELECT * FROM memories WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId}
    ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;
}

/** Mark a user's memories as in use (at most one write per day), so retention counts from the last use. */
export async function touchMemories(sql: Sql, tenantId: string, subjectId: string): Promise<void> {
  await sql`
    UPDATE memories SET last_used_at = now()
    WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId} AND last_used_at < now() - interval '1 day'`;
}

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.!。]+/g, " ").trim();

/** Save a fact; an identical one is refreshed instead of duplicated. Keeps at most MAX_MEMORIES. */
export async function addMemory(
  sql: Sql,
  p: { tenantId: string; subjectId: string; content: string; conversationId: string | null },
): Promise<MemoryRow> {
  const content = p.content.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);
  return sql.begin(async (tx) => {
    // Serialize writes per user so the cap and de-duplication hold under concurrency.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`memory:${p.tenantId}:${p.subjectId}`}))`;
    const existing = await tx<MemoryRow[]>`SELECT * FROM memories WHERE tenant_id = ${p.tenantId} AND subject_id = ${p.subjectId}`;
    const same = existing.find((m) => normalize(m.content) === normalize(content));
    let row: MemoryRow;
    if (same) {
      [row] = (await tx<MemoryRow[]>`UPDATE memories SET updated_at = now() WHERE id = ${same.id} RETURNING *`) as unknown as [MemoryRow];
    } else {
      [row] = (await tx<MemoryRow[]>`
        INSERT INTO memories (id, tenant_id, subject_id, content, conversation_id)
        VALUES (${newId("mem")}, ${p.tenantId}, ${p.subjectId}, ${content}, ${p.conversationId}) RETURNING *`) as unknown as [MemoryRow];
    }
    await tx`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE tenant_id = ${p.tenantId} AND subject_id = ${p.subjectId}
        ORDER BY updated_at DESC, id DESC OFFSET ${MAX_MEMORIES})`;
    return row;
  }) as Promise<MemoryRow>;
}

export async function deleteMemory(sql: Sql, tenantId: string, subjectId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM memories WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId} AND id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deleteAllMemories(sql: Sql, tenantId: string, subjectId: string): Promise<number> {
  const rows = await sql`DELETE FROM memories WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId} RETURNING id`;
  return rows.length;
}

const rememberDef: ToolDef = {
  name: REMEMBER_TOOL,
  description:
    "Save one short fact about the user for future conversations, written in the third person (e.g. \"Uses the Pro plan\", " +
    "\"Prefers answers in Italian\"). Use it when the user shares a lasting preference or detail that will help later, " +
    "or asks you to remember something. Never save passwords, payment or bank details, health information, or anything the " +
    "user did not mean to share. The user can see and erase what you save.",
  parameters: {
    type: "object",
    properties: { fact: { type: "string", minLength: 3, maxLength: MAX_MEMORY_CHARS, description: "One fact, one sentence." } },
    required: ["fact"],
    additionalProperties: false,
  },
};

const forgetDef: ToolDef = {
  name: FORGET_TOOL,
  description: "Delete a saved fact about the user, by its number in <memory>. Use it when the user asks you to forget something or a fact is no longer true.",
  parameters: {
    type: "object",
    properties: { number: { type: "integer", minimum: 1, description: "The fact's number in <memory>." } },
    required: ["number"],
    additionalProperties: false,
  },
};

/** The user's memories for one run: the prompt block and the two tools. */
export function memorySession(
  sql: Sql,
  p: { tenantId: string; subjectId: string; conversationId: string; redact: boolean; rows: MemoryRow[] },
): { facts: string[]; tools: RunTool[] } {
  // The model refers to facts by number; ids stay server-side.
  const numbered = new Map<number, string>(p.rows.map((r, i) => [i + 1, r.id]));
  let next = p.rows.length + 1;
  const remember: RunTool = {
    def: rememberDef,
    title: "Saving to memory",
    kind: "builtin",
    confirm: false,
    run: async (input) => {
      let fact = String(input.fact ?? "").trim();
      if (p.redact) fact = redactPii(fact);
      if (fact.length < 3) return { content: "Nothing to save.", isError: true };
      const row = await addMemory(sql, { tenantId: p.tenantId, subjectId: p.subjectId, content: fact, conversationId: p.conversationId });
      const n = [...numbered].find(([, id]) => id === row.id)?.[0] ?? next++;
      numbered.set(n, row.id);
      return { content: `Saved as fact ${n}.`, isError: false };
    },
  };
  const forget: RunTool = {
    def: forgetDef,
    title: "Updating memory",
    kind: "builtin",
    confirm: false,
    run: async (input) => {
      const id = numbered.get(Number(input.number));
      if (!id) return { content: "There is no fact with that number.", isError: true };
      numbered.delete(Number(input.number));
      await deleteMemory(sql, p.tenantId, p.subjectId, id);
      return { content: "Deleted.", isError: false };
    },
  };
  return { facts: p.rows.map((r) => r.content), tools: [remember, forget] };
}
