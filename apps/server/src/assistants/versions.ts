/** Assistant version history: every saved configuration, with what changed and who changed it. */
import { AssistantConfig, type AssistantVersion } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import type { AssistantRow } from "../db/store.js";
import { iso } from "../lib/time.js";

interface VersionRow {
  version: number;
  config: Record<string, unknown>;
  created_by: string | null;
  note: string | null;
  created_at: Date;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** Top-level fields whose values differ. */
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  if (!before) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((k) => stable(before[k]) !== stable(after[k])).sort();
}

export async function listVersions(sql: Sql, tenantId: string, assistantId: string, limit = 100): Promise<AssistantVersion[]> {
  // One extra (older) row so the oldest listed version also reports its changes.
  const rows = await sql<VersionRow[]>`
    SELECT version, config, created_by, note, created_at FROM assistant_versions
    WHERE tenant_id = ${tenantId} AND assistant_id = ${assistantId} ORDER BY version DESC LIMIT ${limit + 1}`;
  return rows.slice(0, limit).map((r, i) => ({
    version: r.version,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    note: r.note,
    changes: changedFields(rows[i + 1]?.config ?? null, r.config),
  }));
}

export async function getVersion(sql: Sql, tenantId: string, assistantId: string, version: number) {
  const [r] = await sql<VersionRow[]>`
    SELECT version, config, created_by, note, created_at FROM assistant_versions
    WHERE tenant_id = ${tenantId} AND assistant_id = ${assistantId} AND version = ${version}`;
  if (!r) return null;
  const [prev] = await sql<{ config: Record<string, unknown> }[]>`
    SELECT config FROM assistant_versions WHERE assistant_id = ${assistantId} AND version < ${version} ORDER BY version DESC LIMIT 1`;
  // Versions saved by older releases lack newer fields: fill them with defaults.
  const config = AssistantConfig.parse(withDefaults(r.config));
  return {
    version: r.version,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    note: r.note,
    changes: changedFields(prev?.config ?? null, r.config),
    config,
  };
}

function withDefaults(c: Record<string, unknown>): Record<string, unknown> {
  return { guardrails: {}, memory: false, ...c };
}

/** An assistant row as it was at a saved version (for evaluating that version). */
export function rowAtVersion(current: AssistantRow, config: AssistantConfig, version: number): AssistantRow {
  return {
    ...current,
    name: config.name,
    instructions: config.instructions,
    model_alias: config.modelAlias,
    greeting: config.greeting,
    suggestions: config.suggestions,
    placeholder: config.placeholder,
    disclaimer: config.disclaimer,
    source_ids: config.sourceIds,
    grounded_only: config.groundedOnly,
    action_ids: config.actionIds,
    mcp_server_ids: config.mcpServerIds,
    handoff: config.handoff,
    follow_ups: config.followUps,
    query_rewrite: config.queryRewrite,
    agentic_search: config.agenticSearch,
    client_tools: config.clientTools,
    redact_pii: config.redactPii,
    guardrails: config.guardrails,
    memory: config.memory,
    version,
  };
}
