/** Run traces: what happened while each answer of a conversation was produced (for the console's inspector). */
import type { GuardrailKind, RunTrace } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { iso } from "../lib/time.js";

interface RunRow {
  id: string;
  status: RunTrace["status"];
  user_message_id: string;
  assistant_message_id: string | null;
  model_alias: string;
  deployment_id: string | null;
  assistant_version: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  first_token_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  retrieval_query: string | null;
  guardrail: string | null;
  guardrail_detail: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Runs of a conversation, oldest first, each with its events folded into a trace. */
export async function conversationTraces(sql: Sql, tenantId: string, conversationId: string, limit = 100): Promise<RunTrace[]> {
  const runs = await sql<RunRow[]>`
    SELECT id, status, user_message_id, assistant_message_id, model_alias, deployment_id, assistant_version,
           created_at, started_at, finished_at, first_token_ms, input_tokens, output_tokens, retrieval_query,
           guardrail, guardrail_detail, error_code, error_message
    FROM runs WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
    ORDER BY created_at DESC LIMIT ${limit}`;
  if (!runs.length) return [];
  runs.reverse();
  const events = await sql<EventRow[]>`
    SELECT run_id, seq, type, CASE WHEN type = 'message.delta' THEN '{}'::jsonb ELSE data END AS data, created_at FROM run_events
    WHERE run_id = ANY(${runs.map((r) => r.id)}) ORDER BY run_id, seq`;
  const byRun = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = byRun.get(e.run_id);
    if (list) list.push(e);
    else byRun.set(e.run_id, [e]);
  }
  return runs.map((r) => toTrace(r, byRun.get(r.id) ?? []));
}

export function toTrace(r: RunRow, events: EventRow[]): RunTrace {
  const start = (r.started_at ?? r.created_at).getTime();
  const at = (d: Date) => Math.max(0, d.getTime() - start);
  let deltaCount = 0;
  let sources: RunTrace["sources"] = [];
  let handoff = false;
  const timeline: RunTrace["timeline"] = [];
  const tools = new Map<string, RunTrace["tools"][number]>();
  for (const e of events) {
    if (e.type === "message.delta") {
      deltaCount++;
      continue;
    }
    timeline.push({ seq: e.seq, type: e.type, atMs: at(e.created_at) });
    const callId = str(e.data.callId);
    switch (e.type) {
      case "retrieval.completed":
        // Extra searches replace the set given to the model: keep the last one.
        if (Array.isArray(e.data.sources)) sources = e.data.sources as RunTrace["sources"];
        break;
      case "handoff.requested":
        handoff = true;
        break;
      case "tool.started":
      case "tool.input_required":
        if (callId) {
          tools.set(callId, {
            callId,
            name: str(e.data.name) ?? "",
            title: str(e.data.title),
            kind: e.type === "tool.started" ? "server" : e.data.kind === "client" ? "client" : "confirmation",
            startedMs: at(e.created_at),
            durationMs: null,
            isError: null,
          });
        }
        break;
      case "tool.completed": {
        const t = callId ? tools.get(callId) : undefined;
        if (t) {
          t.durationMs = Math.max(0, at(e.created_at) - t.startedMs);
          t.isError = e.data.isError === true;
        }
        break;
      }
    }
  }
  return {
    runId: r.id,
    status: r.status,
    questionMessageId: r.user_message_id,
    answerMessageId: r.assistant_message_id,
    modelAlias: r.model_alias,
    deploymentId: r.deployment_id,
    assistantVersion: r.assistant_version,
    createdAt: iso(r.created_at),
    durationMs: r.finished_at ? Math.max(0, r.finished_at.getTime() - start) : null,
    firstTokenMs: r.first_token_ms,
    usage: { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 },
    retrievalQuery: r.retrieval_query,
    sources,
    tools: [...tools.values()],
    handoff,
    guardrail: r.guardrail ? { kind: r.guardrail as GuardrailKind, detail: r.guardrail_detail } : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
    timeline,
    deltaCount,
  };
}
