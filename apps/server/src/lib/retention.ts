import type { Sql } from "../db/pool.js";

/**
 * Permanently delete conversations past their tenant's retention period
 * (or the server default), legacy soft-deleted conversations, and finished
 * job rows older than 30 days. Bounded batches keep each pass cheap.
 */
export async function purgeExpired(sql: Sql, defaultDays: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const rows = await sql`
      DELETE FROM conversations WHERE id IN (
        SELECT c.id FROM conversations c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.deleted_at IS NOT NULL
           OR (coalesce(t.retention_days, ${defaultDays}) > 0
               AND c.updated_at < now() - make_interval(days => coalesce(t.retention_days, ${defaultDays})))
        LIMIT 500)
      RETURNING id`;
    total += rows.length;
    if (rows.length < 500) break;
  }
  // Memories not used within the retention period go too.
  await sql`
    DELETE FROM memories m USING tenants t
    WHERE t.id = m.tenant_id AND coalesce(t.retention_days, ${defaultDays}) > 0
      AND greatest(m.updated_at, m.last_used_at) < now() - make_interval(days => coalesce(t.retention_days, ${defaultDays}))`;
  await sql`DELETE FROM jobs WHERE status IN ('succeeded', 'failed') AND updated_at < now() - interval '30 days'`;
  // Live events are only needed while clients are connected; the messages themselves stay.
  await sql`DELETE FROM conversation_events WHERE created_at < now() - interval '7 days'`;
  return total;
}
