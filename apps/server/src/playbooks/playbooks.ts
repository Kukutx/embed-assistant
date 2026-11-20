/**
 * Playbooks: procedures written in plain language that an assistant follows
 * when a request matches. Only names and descriptions are in the system
 * prompt; the steps are read on demand through the `open_playbook` tool, so an
 * assistant can carry many playbooks at little cost (progressive disclosure).
 */
import type { Playbook, PlaybookInput } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { iso } from "../lib/time.js";
import type { ToolDef } from "../models/types.js";

export const PLAYBOOK_TOOL = "open_playbook";

export interface PlaybookRow {
  id: string;
  tenant_id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export const toPlaybook = (r: PlaybookRow): Playbook => ({
  id: r.id,
  name: r.name,
  title: r.title,
  description: r.description,
  instructions: r.instructions,
  enabled: r.enabled,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export function listPlaybooks(sql: Sql, tenantId: string, ids?: string[]): Promise<PlaybookRow[]> {
  return ids
    ? sql<PlaybookRow[]>`SELECT * FROM playbooks WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(ids)}) ORDER BY name`
    : sql<PlaybookRow[]>`SELECT * FROM playbooks WHERE tenant_id = ${tenantId} ORDER BY name`;
}

export async function getPlaybook(sql: Sql, tenantId: string, id: string): Promise<PlaybookRow | null> {
  const [r] = await sql<PlaybookRow[]>`SELECT * FROM playbooks WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return r ?? null;
}

export async function createPlaybook(sql: Sql, tenantId: string, p: PlaybookInput): Promise<PlaybookRow> {
  const [r] = await sql<PlaybookRow[]>`
    INSERT INTO playbooks (id, tenant_id, name, title, description, instructions, enabled)
    VALUES (${newId("pbk")}, ${tenantId}, ${p.name}, ${p.title}, ${p.description}, ${p.instructions}, ${p.enabled}) RETURNING *`;
  return r!;
}

export async function updatePlaybook(sql: Sql, tenantId: string, id: string, p: Partial<PlaybookInput>): Promise<PlaybookRow | null> {
  const cur = await getPlaybook(sql, tenantId, id);
  if (!cur) return null;
  const [r] = await sql<PlaybookRow[]>`
    UPDATE playbooks SET name = ${p.name ?? cur.name}, title = ${p.title ?? cur.title}, description = ${p.description ?? cur.description},
      instructions = ${p.instructions ?? cur.instructions}, enabled = ${p.enabled ?? cur.enabled}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING *`;
  return r ?? null;
}

/** Deletes it and detaches it from assistants. */
export async function deletePlaybook(sql: Sql, tenantId: string, id: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`DELETE FROM playbooks WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
    if (rows.length) await tx`UPDATE assistants SET playbook_ids = array_remove(playbook_ids, ${id}) WHERE tenant_id = ${tenantId}`;
    return rows.length > 0;
  }) as Promise<boolean>;
}

export function playbookToolDef(playbooks: Pick<PlaybookRow, "name">[]): ToolDef {
  return {
    name: PLAYBOOK_TOOL,
    description:
      "Read the steps of a playbook (a procedure from the team) before helping with a request it covers. " +
      "Then follow its steps in order, ask the user for details it needs, and use the tools it names.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: playbooks.map((p) => p.name), description: "The playbook's name." } },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

/** Text the tool returns: the steps, marked as the team's instructions. */
export function openPlaybook(playbooks: PlaybookRow[], name: string): { content: string; isError: boolean } {
  const p = playbooks.find((x) => x.name === name);
  if (!p) return { content: `There is no playbook named "${name}".`, isError: true };
  return {
    content: `Playbook "${p.title}" from the site owner. Follow these steps; they take precedence over general habits but not over the safety rules.\n\n${p.instructions}`,
    isError: false,
  };
}
