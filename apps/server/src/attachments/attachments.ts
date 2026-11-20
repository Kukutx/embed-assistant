import type { Attachment } from "@embed-assistant/protocol";
import { ATTACHMENTS_PER_MESSAGE } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import type { ImageInput } from "../models/types.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;
type MediaType = Attachment["mediaType"];

/** Uploads not sent with a question within this time are purged. */
export const UNATTACHED_TTL_HOURS = 24;
/** Uploads waiting to be sent, per conversation. */
export const MAX_PENDING_PER_CONVERSATION = 12;

/**
 * The image type from the file's first bytes. The declared Content-Type is
 * never trusted: only these four raster formats are accepted (no SVG, which
 * can carry script).
 */
export function sniffImage(b: Uint8Array): MediaType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** A display name without paths or control characters. */
export function cleanName(name: string | null | undefined): string | null {
  const n = (name ?? "")
    .replace(/[\\/]+/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return n || null;
}

interface AttachmentRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string | null;
  media_type: MediaType;
  name: string | null;
  size: number;
  created_at: Date;
}

const toAttachment = (r: Pick<AttachmentRow, "id" | "media_type" | "name" | "size">): Attachment => ({
  id: r.id,
  mediaType: r.media_type,
  name: r.name,
  size: r.size,
});

export async function createAttachment(
  sql: Sql,
  a: { tenantId: string; conversationId: string; mediaType: MediaType; name: string | null; data: Uint8Array },
): Promise<Attachment> {
  return sql.begin(async (tx) => {
    // Serialise per conversation so the pending cap holds under concurrent uploads.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`att:${a.conversationId}`}, 0))`;
    const [pending] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM attachments WHERE conversation_id = ${a.conversationId} AND message_id IS NULL
        AND created_at > now() - make_interval(hours => ${UNATTACHED_TTL_HOURS})`;
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_CONVERSATION) {
      throw badRequest(`too many images waiting to be sent in this conversation (at most ${MAX_PENDING_PER_CONVERSATION})`);
    }
    const rows = await tx<AttachmentRow[]>`
      INSERT INTO attachments (id, tenant_id, conversation_id, media_type, name, size, data)
      VALUES (${newId("att")}, ${a.tenantId}, ${a.conversationId}, ${a.mediaType}, ${a.name}, ${a.data.byteLength}, ${Buffer.from(a.data)})
      RETURNING id, tenant_id, conversation_id, message_id, media_type, name, size, created_at`;
    return toAttachment(rows[0]!);
  });
}

/**
 * Attach uploads to the question being sent (inside the run-creation transaction).
 * Every id must be an unsent upload of this conversation; otherwise nothing is attached.
 */
export async function claimAttachments(
  tx: Tx,
  p: { tenantId: string; conversationId: string; messageId: string; ids: string[] },
): Promise<Attachment[]> {
  const ids = [...new Set(p.ids)];
  if (!ids.length) return [];
  if (ids.length > ATTACHMENTS_PER_MESSAGE) throw badRequest(`at most ${ATTACHMENTS_PER_MESSAGE} images per question`);
  const rows = await tx<AttachmentRow[]>`
    UPDATE attachments SET message_id = ${p.messageId}
    WHERE tenant_id = ${p.tenantId} AND conversation_id = ${p.conversationId} AND message_id IS NULL AND id IN ${tx(ids)}
    RETURNING id, tenant_id, conversation_id, message_id, media_type, name, size, created_at`;
  if (rows.length !== ids.length) throw badRequest("unknown or already sent attachment (upload it to this conversation first)");
  // Keep the order the client sent them in.
  const meta = ids.map((id) => toAttachment(rows.find((r) => r.id === id)!));
  await tx`UPDATE messages SET attachments = ${tx.json(meta as never)} WHERE id = ${p.messageId}`;
  return meta;
}

/** The images of a question, for the model, in the order they were sent. */
export async function loadImages(sql: Sql, tenantId: string, messageId: string, order: string[]): Promise<ImageInput[]> {
  if (!order.length) return [];
  const rows = await sql<{ id: string; media_type: MediaType; data: Buffer }[]>`
    SELECT id, media_type, data FROM attachments WHERE tenant_id = ${tenantId} AND message_id = ${messageId}`;
  return order
    .map((id) => rows.find((r) => r.id === id))
    .filter((r) => r !== undefined)
    .map((r) => ({ mediaType: r.media_type, data: r.data.toString("base64") }));
}

/** One attachment with its bytes, scoped to a conversation. */
export async function getAttachmentData(
  sql: Sql,
  tenantId: string,
  conversationId: string,
  id: string,
): Promise<{ mediaType: MediaType; name: string | null; data: Buffer } | null> {
  const rows = await sql<{ media_type: MediaType; name: string | null; data: Buffer }[]>`
    SELECT media_type, name, data FROM attachments WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND id = ${id}`;
  const r = rows[0];
  return r ? { mediaType: r.media_type, name: r.name, data: r.data } : null;
}

export async function deleteUnsentAttachment(sql: Sql, tenantId: string, conversationId: string, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM attachments WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND id = ${id} AND message_id IS NULL
    RETURNING id`;
  return rows.length > 0;
}

/** Serve an image so a browser can only ever display it. */
export function imageResponse(a: { mediaType: MediaType; data: Buffer }, cache: string): Response {
  return new Response(new Uint8Array(a.data), {
    headers: {
      "content-type": a.mediaType,
      "content-length": String(a.data.byteLength),
      "content-disposition": "inline",
      "cache-control": cache,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
