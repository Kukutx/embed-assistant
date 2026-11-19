import { createHmac, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { Webhook, WebhookEventType, WebhookInput } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { iso } from "../lib/time.js";
import { enqueueJob, type JobRow } from "../knowledge/jobs.js";
import { safeFetch } from "../knowledge/safeFetch.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

export interface WebhookRow {
  id: string;
  tenant_id: string;
  url: string;
  description: string;
  events: WebhookEventType[];
  enabled: boolean;
  secret: string;
  created_at: Date;
  updated_at: Date;
}

export const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  enabled: r.enabled,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Standard Webhooks secret: `whsec_` + base64 of 32 random bytes. */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

export async function listWebhooks(sql: Tx, tenantId: string): Promise<WebhookRow[]> {
  return sql<WebhookRow[]>`SELECT * FROM webhooks WHERE tenant_id = ${tenantId} ORDER BY created_at`;
}

export async function getWebhook(sql: Tx, tenantId: string, id: string): Promise<WebhookRow | null> {
  const rows = await sql<WebhookRow[]>`SELECT * FROM webhooks WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return rows[0] ?? null;
}

export async function createWebhook(sql: Tx, key: Buffer, tenantId: string, w: WebhookInput, secret: string): Promise<WebhookRow> {
  const rows = await sql<WebhookRow[]>`
    INSERT INTO webhooks (id, tenant_id, url, description, events, enabled, secret)
    VALUES (${newId("whk")}, ${tenantId}, ${w.url}, ${w.description}, ${sql.array(w.events)}, ${w.enabled}, ${encrypt(key, secret)})
    RETURNING *`;
  return rows[0]!;
}

export async function updateWebhook(
  sql: Tx,
  key: Buffer,
  tenantId: string,
  id: string,
  p: Partial<WebhookInput> & { secret?: string },
): Promise<WebhookRow | null> {
  const c = await getWebhook(sql, tenantId, id);
  if (!c) return null;
  const rows = await sql<WebhookRow[]>`
    UPDATE webhooks SET url = ${p.url ?? c.url}, description = ${p.description ?? c.description},
      events = ${sql.array(p.events ?? c.events)}, enabled = ${p.enabled ?? c.enabled},
      secret = ${p.secret ? encrypt(key, p.secret) : c.secret}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *`;
  return rows[0] ?? null;
}

export async function deleteWebhook(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  return (await sql`DELETE FROM webhooks WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`).length > 0;
}

/**
 * Queue an event for every enabled webhook subscribed to it. The payload is
 * frozen now, so retries deliver identical bytes with the same `webhook-id`
 * (receivers use it to de-duplicate).
 */
export async function emitWebhook(sql: Tx, tenantId: string, type: WebhookEventType, data: unknown): Promise<number> {
  const hooks = await sql<{ id: string }[]>`
    SELECT id FROM webhooks WHERE tenant_id = ${tenantId} AND enabled AND ${type} = ANY(events)`;
  if (!hooks.length) return 0;
  const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  for (const h of hooks) {
    await enqueueJob(sql as Sql, tenantId, "deliver_webhook", { webhookId: h.id, eventId: newId("evt"), event: type, body });
  }
  return hooks.length;
}

/** `webhook-signature` value per the Standard Webhooks specification. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export async function deliverWebhook(deps: { sql: Sql; key: Buffer; log: Logger; allowPrivate: boolean }, job: JobRow): Promise<void> {
  const p = job.payload as { webhookId: string; eventId: string; event: string; body: string };
  const hook = await getWebhook(deps.sql, job.tenant_id, p.webhookId);
  if (!hook || !hook.enabled) return; // deleted or disabled since: drop silently
  const ts = Math.floor(Date.now() / 1000);
  const res = await safeFetch(hook.url, {
    allowPrivate: deps.allowPrivate,
    method: "POST",
    body: p.body,
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
    accept: "*/*",
    userAgent: "embed-assistant-webhooks/1.0",
    headers: {
      "content-type": "application/json",
      "webhook-id": p.eventId,
      "webhook-timestamp": String(ts),
      "webhook-signature": signWebhook(decrypt(deps.key, hook.secret), p.eventId, ts, p.body),
    },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
}
