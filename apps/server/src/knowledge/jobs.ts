import { hostname } from "node:os";
import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { withSpan } from "../lib/telemetry.js";

export type JobType = "ingest_source" | "deliver_webhook";
export interface JobRow {
  id: string;
  tenant_id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Webhooks retry for about 4 hours (30s, 1m, 2m ... 64m); ingestion three times. */
const MAX_ATTEMPTS: Record<JobType, number> = { ingest_source: 3, deliver_webhook: 9 };
const STALE_AFTER = "15 minutes";

export async function enqueueJob(sql: Sql, tenantId: string, type: JobType, payload: Record<string, unknown>): Promise<string> {
  const id = newId("job");
  await sql`INSERT INTO jobs (id, tenant_id, type, payload) VALUES (${id}, ${tenantId}, ${type}, ${sql.json(payload as never)})`;
  return id;
}

/**
 * Postgres-backed job queue (FOR UPDATE SKIP LOCKED): safe with many workers,
 * survives restarts, no extra infrastructure.
 */
export class JobWorker {
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(
    private readonly sql: Sql,
    private readonly log: Logger,
    private readonly handlers: Record<JobType, (job: JobRow) => Promise<void>>,
    private readonly idleMs = 1000,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** Claim and run one job; returns false when the queue is empty. */
  async tick(): Promise<boolean> {
    await this.sql`
      UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - ${STALE_AFTER}::interval`;
    const rows = await this.sql<JobRow[]>`
      UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${this.workerId},
                      attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, tenant_id, type, payload, attempts`;
    const job = rows[0];
    if (!job) return false;
    try {
      await withSpan(`job ${job.type}`, { attributes: { "embed_assistant.job_id": job.id, "embed_assistant.job_attempt": job.attempts } }, () =>
        this.handlers[job.type](job),
      );
      await this.sql`UPDATE jobs SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = ${job.id}`;
    } catch (err) {
      const message = (err as Error).message?.slice(0, 1000) ?? String(err);
      const final = job.attempts >= (MAX_ATTEMPTS[job.type] ?? 3);
      this.log.warn({ job: job.id, type: job.type, attempt: job.attempts, err: message }, "job failed");
      await this.sql`
        UPDATE jobs SET status = ${final ? "failed" : "queued"}, last_error = ${message}, locked_at = NULL,
          run_after = now() + (${Math.min(3600, 15 * 2 ** job.attempts)} || ' seconds')::interval, updated_at = now()
        WHERE id = ${job.id}`;
    }
    return true;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (err) {
        this.log.error({ err }, "job worker error");
      }
      if (!worked) await new Promise((r) => setTimeout(r, this.idleMs));
    }
  }
}
