import { EventEmitter } from "node:events";
import type { ConversationEvent, ConversationEventType, RunEvent, RunEventType } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";

const CHANNEL = "ea_run_events";
const CONV_CHANNEL = "ea_conversation_events";

/**
 * Run events are persisted (source of truth, enables resume) and announced:
 * in-process via an EventEmitter, across instances via Postgres NOTIFY.
 * Subscribers react to an announcement by reading new rows after their last seq.
 */
export class RunEventBus {
  private readonly local = new EventEmitter();
  private listening: Promise<unknown> | null = null;

  constructor(private readonly sql: Sql) {
    this.local.setMaxListeners(0);
  }

  async listen(): Promise<void> {
    this.listening ??= Promise.all([
      this.sql.listen(CHANNEL, (payload) => this.local.emit(payload)),
      this.sql.listen(CONV_CHANNEL, (payload) => this.local.emit(`conv:${payload}`)),
    ]);
    await this.listening;
  }

  async append<T extends RunEventType>(
    runId: string,
    seq: number,
    type: T,
    data: Extract<RunEvent, { type: T }>["data"],
  ): Promise<void> {
    await this.sql`INSERT INTO run_events (run_id, seq, type, data) VALUES (${runId}, ${seq}, ${type}, ${this.sql.json(data as never)})`;
    this.local.emit(runId);
    // Other instances; payload is just the run id (NOTIFY payloads are capped at 8 KB).
    await this.sql`SELECT pg_notify(${CHANNEL}, ${runId})`;
  }

  async since(runId: string, afterSeq: number): Promise<RunEvent[]> {
    const rows = await this.sql<{ seq: number; type: string; data: unknown; created_at: Date }[]>`
      SELECT seq, type, data, created_at FROM run_events WHERE run_id = ${runId} AND seq > ${afterSeq} ORDER BY seq`;
    return rows.map((r) => ({ seq: r.seq, runId, type: r.type, data: r.data, ts: r.created_at.toISOString() }) as RunEvent);
  }

  onAnnounce(runId: string, fn: () => void): () => void {
    this.local.on(runId, fn);
    return () => this.local.off(runId, fn);
  }

  // ---------------------------------------------------------------- conversation events

  async appendConversation<T extends ConversationEventType>(
    conversationId: string,
    type: T,
    data: Extract<ConversationEvent, { type: T }>["data"],
  ): Promise<number> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO conversation_events (conversation_id, type, data) VALUES (${conversationId}, ${type}, ${this.sql.json(data as never)}) RETURNING id`;
    this.local.emit(`conv:${conversationId}`);
    await this.sql`SELECT pg_notify(${CONV_CHANNEL}, ${conversationId})`;
    return Number(row!.id);
  }

  async conversationSince(conversationId: string, afterId: number): Promise<ConversationEvent[]> {
    const rows = await this.sql<{ id: string; type: string; data: unknown; created_at: Date }[]>`
      SELECT id, type, data, created_at FROM conversation_events
      WHERE conversation_id = ${conversationId} AND id > ${afterId} ORDER BY id LIMIT 200`;
    return rows.map((r) => ({ id: Number(r.id), conversationId, type: r.type, data: r.data, ts: r.created_at.toISOString() }) as ConversationEvent);
  }

  /** Id of the newest event, so a new subscriber starts from "now". */
  async lastConversationEventId(conversationId: string): Promise<number> {
    const [r] = await this.sql<{ id: string | null }[]>`SELECT max(id) AS id FROM conversation_events WHERE conversation_id = ${conversationId}`;
    return Number(r?.id ?? 0);
  }

  onConversation(conversationId: string, fn: () => void): () => void {
    const key = `conv:${conversationId}`;
    this.local.on(key, fn);
    return () => this.local.off(key, fn);
  }
}
