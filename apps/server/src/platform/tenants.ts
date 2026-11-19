/** Tenant lifecycle for operators of a multi-tenant installation. */
import type { Tenant } from "@embed-assistant/protocol";
import { generateAdminKey } from "../auth/adminKey.js";
import type { Sql } from "../db/pool.js";
import { insertAdminKey } from "../db/store.js";
import { newId } from "../lib/ids.js";
import { iso, isoOrNull } from "../lib/time.js";

export interface TenantRow {
  id: string;
  name: string;
  external_id: string | null;
  status: "active" | "suspended";
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
  suspended_at: Date | null;
  conversations?: string | null;
  input_tokens?: string | null;
  output_tokens?: string | null;
}

export const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  name: r.name,
  externalId: r.external_id,
  status: r.status,
  metadata: r.metadata ?? {},
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  suspendedAt: isoOrNull(r.suspended_at),
  usage: { conversations: Number(r.conversations ?? 0), inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0) },
});

/** Tenant columns plus 30-day usage. */
const WITH_USAGE = (sql: Sql) => sql`
  t.*,
  (SELECT count(*) FROM conversations c WHERE c.tenant_id = t.id AND c.created_at >= now() - interval '30 days') AS conversations,
  (SELECT coalesce(sum(r.input_tokens), 0) FROM runs r WHERE r.tenant_id = t.id AND r.created_at >= now() - interval '30 days') AS input_tokens,
  (SELECT coalesce(sum(r.output_tokens), 0) FROM runs r WHERE r.tenant_id = t.id AND r.created_at >= now() - interval '30 days') AS output_tokens`;

export async function listTenants(
  sql: Sql,
  p: { limit: number; cursor?: string | undefined; status?: "active" | "suspended" | undefined; externalId?: string | undefined; q?: string | undefined },
): Promise<{ items: TenantRow[]; nextCursor: string | null }> {
  // Tenant ids are ULIDs: id order is creation order and a stable cursor.
  const rows = await sql<TenantRow[]>`
    SELECT ${WITH_USAGE(sql)} FROM tenants t
    WHERE true
      ${p.cursor ? sql`AND t.id > ${p.cursor}` : sql``}
      ${p.status ? sql`AND t.status = ${p.status}` : sql``}
      ${p.externalId ? sql`AND t.external_id = ${p.externalId}` : sql``}
      ${p.q ? sql`AND t.name ILIKE ${`%${p.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : sql``}
    ORDER BY t.id LIMIT ${p.limit + 1}`;
  const more = rows.length > p.limit;
  const items = more ? rows.slice(0, p.limit) : rows;
  return { items, nextCursor: more ? items.at(-1)!.id : null };
}

export async function getTenant(sql: Sql, id: string): Promise<TenantRow | null> {
  const [row] = await sql<TenantRow[]>`SELECT ${WITH_USAGE(sql)} FROM tenants t WHERE t.id = ${id}`;
  return row ?? null;
}

export async function createTenantWithKey(
  sql: Sql,
  p: { name: string; externalId: string | null; metadata: Record<string, string>; adminKeyName: string },
): Promise<{ tenant: TenantRow; key: string }> {
  return sql.begin(async (tx) => {
    const id = newId("ten");
    const [row] = await tx<TenantRow[]>`
      INSERT INTO tenants (id, name, external_id, metadata) VALUES (${id}, ${p.name}, ${p.externalId}, ${tx.json(p.metadata)})
      RETURNING *`;
    const k = generateAdminKey();
    await insertAdminKey(tx, id, p.adminKeyName, k.hash, k.prefix);
    return { tenant: row!, key: k.key };
  }) as Promise<{ tenant: TenantRow; key: string }>;
}

export async function updateTenant(
  sql: Sql,
  id: string,
  p: { name?: string | undefined; externalId?: string | null | undefined; metadata?: Record<string, string> | undefined; status?: "active" | "suspended" | undefined },
): Promise<TenantRow | null> {
  const [row] = await sql<TenantRow[]>`
    UPDATE tenants SET
      name = coalesce(${p.name ?? null}, name),
      external_id = ${p.externalId === undefined ? sql`external_id` : p.externalId},
      metadata = ${p.metadata === undefined ? sql`metadata` : sql.json(p.metadata)},
      status = coalesce(${p.status ?? null}, status),
      suspended_at = CASE WHEN ${p.status ?? null}::text = 'suspended' AND status <> 'suspended' THEN now()
                          WHEN ${p.status ?? null}::text = 'active' THEN NULL ELSE suspended_at END,
      updated_at = now()
    WHERE id = ${id} RETURNING id`;
  return row ? getTenant(sql, id) : null;
}

/** Tables keyed by tenant without a cascading foreign key to tenants. */
const LOOSE_TABLES = ["jobs"] as const;

/** Delete a tenant and everything it owns. The tenant must be suspended first. */
export async function deleteTenant(sql: Sql, id: string): Promise<"deleted" | "not_found" | "active"> {
  return sql.begin(async (tx) => {
    const [t] = await tx<{ status: string }[]>`SELECT status FROM tenants WHERE id = ${id} FOR UPDATE`;
    if (!t) return "not_found";
    if (t.status !== "suspended") return "active";
    for (const table of LOOSE_TABLES) await tx`DELETE FROM ${tx(table)} WHERE tenant_id = ${id}`;
    // Conversations cascade to messages, runs and events; sources to documents and chunks.
    await tx`DELETE FROM tenants WHERE id = ${id}`;
    return "deleted";
  }) as Promise<"deleted" | "not_found" | "active">;
}

export async function issueAdminKey(sql: Sql, tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
  const k = generateAdminKey();
  const id = await insertAdminKey(sql, tenantId, name, k.hash, k.prefix);
  return { id, key: k.key, prefix: k.prefix };
}
