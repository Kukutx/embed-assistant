import { EventEmitter } from "node:events";
import type { RunEvent, RunEventType } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";

const CHANNEL = "ea_run_events";

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
    this.listening ??= this.sql.listen(CHANNEL, (payload) => this.local.emit(payload));
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
}
