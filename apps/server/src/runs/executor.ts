import type { Logger } from "pino";
import type { PageContext } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { finishMessage, insertMessage, toMessage, type AssistantRow, type MessageRow } from "../db/store.js";
import { retrieve } from "../knowledge/retrieve.js";
import { metrics } from "../lib/metrics.js";
import type { ModelRegistry } from "../models/registry.js";
import { ModelError } from "../models/types.js";
import { buildSystemPrompt, buildUserTurn, extractCitations, toCitation, trimHistory } from "./prompt.js";
import type { RunEventBus } from "./events.js";

export interface RunJob {
  runId: string;
  tenantId: string;
  conversationId: string;
  userMessage: MessageRow;
  assistant: AssistantRow;
  access: string[];
  context?: PageContext | undefined;
}

const FLUSH_MS = 50;
const FLUSH_CHARS = 160;
const HEARTBEAT_MS = 2000;
const MAX_RUN_MS = 3 * 60_000;
const REFUSAL_TEXT = "Sorry, I can't help with that request.";

/**
 * Executes runs in-process. Each run has exactly one writer (this executor),
 * so event sequence numbers are assigned locally without contention.
 */
export class RunExecutor {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly sql: Sql,
    private readonly bus: RunEventBus,
    private readonly models: ModelRegistry,
    private readonly log: Logger,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  /** Fire and forget; errors are recorded on the run. */
  start(job: RunJob): void {
    const controller = new AbortController();
    this.active.set(job.runId, controller);
    void this.execute(job, controller)
      .catch((err) => this.log.error({ err, run: job.runId }, "run crashed"))
      .finally(() => this.active.delete(job.runId));
  }

  /** Cancel locally if running here; other instances notice via the heartbeat poll. */
  cancelLocal(runId: string): boolean {
    const c = this.active.get(runId);
    if (!c) return false;
    c.abort(new Error("cancelled"));
    return true;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const c of this.active.values()) c.abort(new Error("server shutting down"));
  }

  /** Mark runs whose executor died (no heartbeat) as failed. */
  async reapStale(): Promise<number> {
    const rows = await this.sql<{ id: string; assistant_message_id: string | null }[]>`
      UPDATE runs SET status = 'failed', error_code = 'executor_lost', error_message = 'run interrupted', finished_at = now()
      WHERE status IN ('queued', 'running') AND coalesce(heartbeat_at, created_at) < now() - interval '30 seconds'
      RETURNING id, assistant_message_id`;
    for (const r of rows) {
      const seq = await this.nextSeq(r.id);
      await this.bus.append(r.id, seq, "run.failed", { code: "executor_lost", message: "The answer was interrupted. Please try again." });
      if (r.assistant_message_id) await this.sql`UPDATE messages SET status = 'failed' WHERE id = ${r.assistant_message_id} AND status = 'streaming'`;
    }
    return rows.length;
  }

  private async nextSeq(runId: string): Promise<number> {
    const rows = await this.sql<{ max: number | null }[]>`SELECT max(seq) AS max FROM run_events WHERE run_id = ${runId}`;
    return (rows[0]?.max ?? 0) + 1;
  }

  private async execute(job: RunJob, controller: AbortController): Promise<void> {
    const { sql, bus } = this;
    const started = Date.now();
    let seq = 0;
    const emit = bus.append.bind(bus);
    const timeout = setTimeout(() => controller.abort(new Error("run timed out")), MAX_RUN_MS);

    // Heartbeat + cross-instance cancellation check.
    const heartbeat = setInterval(() => {
      void sql<{ status: string }[]>`UPDATE runs SET heartbeat_at = now() WHERE id = ${job.runId} RETURNING status`
        .then((rows) => {
          if (rows[0]?.status === "cancelled") controller.abort(new Error("cancelled"));
        })
        .catch(() => {});
    }, HEARTBEAT_MS);

    let assistantMsg: MessageRow | null = null;
    let text = "";
    let deploymentId: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let firstTokenMs: number | null = null;

    try {
      await sql`UPDATE runs SET status = 'running', started_at = now(), heartbeat_at = now() WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "run.started", { modelAlias: job.assistant.model_alias });

      const sources = await retrieve(sql, this.models.embeddings, this.log, {
        tenantId: job.tenantId,
        sourceIds: job.assistant.source_ids,
        access: job.access,
        query: job.userMessage.content,
      });
      await emit(job.runId, ++seq, "retrieval.completed", { sources: sources.map(toCitation) });

      const historyRows = await sql<{ role: "user" | "assistant"; content: string }[]>`
        SELECT role, content FROM messages
        WHERE conversation_id = ${job.conversationId} AND id <> ${job.userMessage.id} AND status = 'complete'
        ORDER BY created_at DESC, id DESC LIMIT 40`;
      const history = trimHistory(historyRows.reverse());

      assistantMsg = await insertMessage(sql, {
        tenantId: job.tenantId,
        conversationId: job.conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
      });
      await sql`UPDATE runs SET assistant_message_id = ${assistantMsg.id} WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "message.started", { messageId: assistantMsg.id });

      const system = buildSystemPrompt({
        assistantName: job.assistant.name,
        instructions: job.assistant.instructions,
        groundedOnly: job.assistant.grounded_only,
      });
      const messages = [
        ...history,
        { role: "user" as const, content: buildUserTurn({ question: job.userMessage.content, sources, context: job.context }) },
      ];

      let pending = "";
      let lastFlush = Date.now();
      const flush = async () => {
        if (!pending) return;
        const chunk = pending;
        pending = "";
        lastFlush = Date.now();
        await emit(job.runId, ++seq, "message.delta", { messageId: assistantMsg!.id, text: chunk });
      };

      let refused = false;
      for await (const { deploymentId: dep, chunk } of this.models.stream(job.assistant.model_alias, {
        system,
        messages,
        question: job.userMessage.content,
        sources,
        maxOutputTokens: 4096,
        signal: controller.signal,
      })) {
        deploymentId = dep;
        if (chunk.type === "text") {
          firstTokenMs ??= Date.now() - started;
          text += chunk.text;
          pending += chunk.text;
          if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_MS) await flush();
        } else if (chunk.type === "usage") {
          usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        } else if (chunk.type === "refusal") {
          refused = true;
        }
      }
      if (refused && !text.trim()) {
        text = REFUSAL_TEXT;
        pending += REFUSAL_TEXT;
      }
      await flush();

      const citations = extractCitations(text, sources);
      const finished = await finishMessage(sql, job.tenantId, assistantMsg.id, text, citations, "complete");
      await emit(job.runId, ++seq, "message.completed", { message: toMessage(finished) });
      await sql`
        UPDATE runs SET status = 'completed', finished_at = now(), deployment_id = ${deploymentId},
          input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens}, first_token_ms = ${firstTokenMs}
        WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "run.completed", { usage });
      metrics.runs.inc({ status: "completed", deployment: deploymentId ?? "none" });
      metrics.tokens.inc({ direction: "input", deployment: deploymentId ?? "none" }, usage.inputTokens);
      metrics.tokens.inc({ direction: "output", deployment: deploymentId ?? "none" }, usage.outputTokens);
      if (firstTokenMs !== null) metrics.ttft.observe(firstTokenMs, { deployment: deploymentId ?? "none" });
    } catch (err) {
      const cancelled = controller.signal.aborted && String(controller.signal.reason?.message) === "cancelled";
      const status = cancelled ? "cancelled" : "failed";
      const code = cancelled ? "cancelled" : err instanceof ModelError ? "model_error" : "internal_error";
      const publicMessage = cancelled
        ? "Cancelled."
        : err instanceof ModelError
          ? "The AI service is temporarily unavailable. Please try again in a moment."
          : controller.signal.aborted
            ? "The answer took too long. Please try again."
            : "Something went wrong while answering. Please try again.";
      if (!cancelled) this.log.warn({ run: job.runId, err: (err as Error).message }, "run failed");
      try {
        if (assistantMsg) {
          await finishMessage(sql, job.tenantId, assistantMsg.id, text, [], cancelled ? "cancelled" : "failed");
        }
        await sql`
          UPDATE runs SET status = ${status}, finished_at = now(), error_code = ${code},
            error_message = ${(err as Error).message?.slice(0, 1000) ?? null}, deployment_id = ${deploymentId},
            input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens}, first_token_ms = ${firstTokenMs}
          WHERE id = ${job.runId}`;
        if (cancelled) await emit(job.runId, ++seq, "run.cancelled", {});
        else await emit(job.runId, ++seq, "run.failed", { code, message: publicMessage });
      } catch (inner) {
        this.log.error({ err: inner, run: job.runId }, "failed to record run failure");
      }
      metrics.runs.inc({ status, deployment: deploymentId ?? "none" });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      metrics.duration.observe(Date.now() - started);
    }
  }
}
