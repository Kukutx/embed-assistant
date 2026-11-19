import type { Logger } from "pino";
import type { ClientToolDef, PageContext } from "@embed-assistant/protocol";
import { listActions } from "../actions/actions.js";
import type { Sql } from "../db/pool.js";
import { finishMessage, insertMessage, toMessage, type AssistantRow, type MessageRow } from "../db/store.js";
import { retrieve } from "../knowledge/retrieve.js";
import { decrypt } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { validateArguments } from "../lib/jsonSchema.js";
import { metrics } from "../lib/metrics.js";
import type { ModelRegistry } from "../models/registry.js";
import { ModelError, type ChatTurn, type SourcePassage, type ToolCall, type ToolResult } from "../models/types.js";
import { emitWebhook } from "../webhooks/webhooks.js";
import { auxAlias, contextualQuery, suggestFollowUps } from "./assist.js";
import { requestHandoff } from "./handoff.js";
import { buildSystemPrompt, buildUserTurn, extractCitations, toCitation, trimHistory } from "./prompt.js";
import {
  actionTool,
  clientTool,
  handoffToolDef,
  HANDOFF_TOOL,
  SEARCH_TOOL,
  searchToolDef,
  stringifyOutput,
  type RunTool,
} from "./tools.js";
import type { RunEventBus } from "./events.js";

export interface RunSubject {
  id: string;
  kind: "anonymous" | "user";
  name: string | null;
  email?: string | null | undefined;
}

export interface RunJob {
  runId: string;
  tenantId: string;
  widgetId: string;
  conversationId: string;
  userMessage: MessageRow;
  assistant: AssistantRow;
  access: string[];
  subject: RunSubject;
  context?: PageContext | undefined;
  clientTools?: ClientToolDef[] | undefined;
}

export interface ExecutorOptions {
  /** Key that decrypts stored secrets (action headers, widget identity secrets). */
  secretsKey: Buffer;
  allowPrivateNetworks: boolean;
}

const FLUSH_MS = 50;
const FLUSH_CHARS = 160;
const HEARTBEAT_MS = 2000;
const MAX_RUN_MS = 6 * 60_000;
const MAX_TOOL_STEPS = 6;
const INPUT_TIMEOUT_MS = 120_000;
const INPUT_POLL_MS = 400;
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
    private readonly opts: ExecutorOptions,
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

  /** Wait for the widget's answer to a tool.input_required event. */
  private async waitForInput(runId: string, callId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + INPUT_TIMEOUT_MS;
    while (!signal.aborted && Date.now() < deadline) {
      const rows = await this.sql<{ data: Record<string, unknown> }[]>`
        SELECT data FROM run_inputs WHERE run_id = ${runId} AND call_id = ${callId}`;
      if (rows[0]) return rows[0].data;
      await new Promise((r) => setTimeout(r, INPUT_POLL_MS));
    }
    if (signal.aborted) throw signal.reason ?? new Error("cancelled");
    return null;
  }

  private async buildTools(job: RunJob, onSearch: (q: string) => Promise<string>, onHandoff: (reason: string) => Promise<string>): Promise<Map<string, RunTool>> {
    const a = job.assistant;
    const tools = new Map<string, RunTool>();
    if (!this.models.hasLanguageModel(a.model_alias)) return tools;
    if (a.agentic_search && a.source_ids.length) {
      tools.set(SEARCH_TOOL, {
        def: searchToolDef,
        title: "Searching the knowledge base",
        kind: "builtin",
        confirm: false,
        run: async (input) => ({ content: await onSearch(String(input.query ?? "")), isError: false }),
      });
    }
    if (a.handoff.enabled) {
      tools.set(HANDOFF_TOOL, {
        def: handoffToolDef,
        title: "Contacting the team",
        kind: "builtin",
        confirm: false,
        run: async (input) => ({ content: await onHandoff(String(input.reason ?? "")), isError: false }),
      });
    }
    if (a.action_ids.length) {
      const actions = (await listActions(this.sql, job.tenantId, a.action_ids)).filter(
        (x) => x.enabled && (!x.require_user || job.subject.kind === "user"),
      );
      if (actions.length) {
        const w = await this.sql<{ identity_secret: string }[]>`SELECT identity_secret FROM widgets WHERE id = ${job.widgetId}`;
        const signingSecret = w[0] ? decrypt(this.opts.secretsKey, w[0].identity_secret) : null;
        const caller = {
          subjectId: job.subject.id.replace(/^(user|anon):/, ""),
          subjectKind: job.subject.kind,
          name: job.subject.name,
          email: job.subject.email ?? null,
          groups: job.access.filter((g) => g !== "public" && g !== "users"),
          conversationId: job.conversationId,
        };
        for (const x of actions) {
          if (tools.has(x.name)) continue;
          tools.set(x.name, actionTool(x, { key: this.opts.secretsKey, signingSecret, caller, allowPrivate: this.opts.allowPrivateNetworks }));
        }
      }
    }
    if (a.client_tools) for (const t of job.clientTools ?? []) if (!tools.has(t.name)) tools.set(t.name, clientTool(t));
    return tools;
  }

  private async execute(job: RunJob, controller: AbortController): Promise<void> {
    const { sql, bus } = this;
    const started = Date.now();
    let seq = 0;
    const emit = bus.append.bind(bus);
    const timeout = setTimeout(() => controller.abort(new Error("run timed out")), MAX_RUN_MS);
    const signal = controller.signal;

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
    const usage = { inputTokens: 0, outputTokens: 0 };
    let firstTokenMs: number | null = null;
    const toolLog: { name: string; isError: boolean }[] = [];
    const a = job.assistant;

    try {
      await sql`UPDATE runs SET status = 'running', started_at = now(), heartbeat_at = now() WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "run.started", { modelAlias: a.model_alias });

      const historyRows = await sql<{ role: "user" | "assistant"; content: string }[]>`
        SELECT role, content FROM messages
        WHERE conversation_id = ${job.conversationId} AND id <> ${job.userMessage.id} AND status = 'complete'
        ORDER BY created_at DESC, id DESC LIMIT 40`;
      const history = trimHistory(historyRows.reverse());
      const aux = auxAlias(this.models, a.model_alias);

      const query = a.source_ids.length
        ? await contextualQuery(this.models, { alias: aux, question: job.userMessage.content, history, useModel: a.query_rewrite, signal })
        : job.userMessage.content;
      const retrieveFor = (q: string) =>
        retrieve(sql, this.models.embeddings, this.log, { tenantId: job.tenantId, sourceIds: a.source_ids, access: job.access, query: q });
      const sources: SourcePassage[] = await retrieveFor(query);
      await sql`UPDATE runs SET retrieval_query = ${query}, source_count = ${sources.length} WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "retrieval.completed", { sources: sources.map(toCitation) });

      // Extra searches append passages with new numbers so earlier citations stay valid.
      const seen = new Set(sources.map((x) => `${x.documentId}:${x.content.slice(0, 200)}`));
      const onSearch = async (q: string): Promise<string> => {
        const found = await retrieveFor(q.slice(0, 300));
        const fresh: SourcePassage[] = [];
        for (const f of found) {
          const k = `${f.documentId}:${f.content.slice(0, 200)}`;
          if (seen.has(k) || sources.length + fresh.length >= 30) continue;
          seen.add(k);
          fresh.push({ ...f, index: sources.length + fresh.length + 1 });
        }
        sources.push(...fresh);
        if (fresh.length) {
          await emit(job.runId, ++seq, "retrieval.completed", { sources: sources.map(toCitation) });
          await sql`UPDATE runs SET source_count = ${sources.length} WHERE id = ${job.runId}`;
        }
        if (!fresh.length) return found.length ? "No new passages (the results were already provided as sources)." : "No matching passages found.";
        return buildUserTurn({ question: "", sources: fresh, context: undefined }).replace(/\n\nQuestion: $/, "");
      };
      let handedOff = false;
      const onHandoff = async (reason: string): Promise<string> => {
        const r = await requestHandoff(
          { sql, models: this.models, log: this.log },
          { tenantId: job.tenantId, conversationId: job.conversationId, assistant: a, reason: reason || null, trigger: "assistant", subject: job.subject, context: job.context ?? null },
        );
        if (!handedOff) {
          handedOff = true;
          await emit(job.runId, ++seq, "handoff.requested", { message: r.message, url: r.url });
        }
        return `The team has been notified. The user will see this message: "${r.message}"${r.url ? ` and a link to ${r.url}` : ""}. Do not repeat the link.`;
      };
      const tools = await this.buildTools(job, onSearch, onHandoff);

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
        assistantName: a.name,
        instructions: a.instructions,
        groundedOnly: a.grounded_only,
        tools: tools.size
          ? { search: tools.has(SEARCH_TOOL), handoff: tools.has(HANDOFF_TOOL), actions: [...tools.values()].some((t) => t.kind !== "builtin") }
          : undefined,
      });
      const transcript: ChatTurn[] = [
        ...history,
        { role: "user", content: buildUserTurn({ question: job.userMessage.content, sources, context: job.context }) },
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
      const push = async (t: string) => {
        firstTokenMs ??= Date.now() - started;
        text += t;
        pending += t;
        if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_MS) await flush();
      };

      let refused = false;
      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const lastStep = step === MAX_TOOL_STEPS - 1;
        let stepText = "";
        const calls: ToolCall[] = [];
        let raw: { provider: string; content: unknown } | undefined;
        const sep = text && !text.endsWith("\n") ? "\n\n" : "";
        let sepSent = false;
        for await (const { deploymentId: dep, chunk } of this.models.stream(a.model_alias, {
          system,
          messages: transcript,
          question: job.userMessage.content,
          sources,
          maxOutputTokens: 4096,
          signal,
          ...(tools.size && !lastStep ? { tools: [...tools.values()].map((t) => t.def) } : {}),
        })) {
          deploymentId = dep;
          if (chunk.type === "text") {
            if (!sepSent && sep) {
              sepSent = true;
              await push(sep);
            }
            stepText += chunk.text;
            await push(chunk.text);
          } else if (chunk.type === "usage") {
            usage.inputTokens += chunk.inputTokens;
            usage.outputTokens += chunk.outputTokens;
          } else if (chunk.type === "refusal") {
            refused = true;
          } else if (chunk.type === "tool_call") {
            calls.push(chunk.call);
          } else if (chunk.type === "raw") {
            raw = { provider: chunk.provider, content: chunk.content };
          }
        }
        if (!calls.length || refused) break;
        await flush();
        transcript.push({ role: "assistant", content: stepText, toolCalls: calls, ...(raw ? { raw } : {}) });
        const results: ToolResult[] = [];
        for (const call of calls) {
          const r = await this.runTool(job, tools, call, signal, () => ++seq);
          toolLog.push({ name: call.name, isError: r.isError });
          results.push({ callId: call.id, name: call.name, content: r.content, isError: r.isError });
        }
        transcript.push({ role: "tool", results });
      }
      if (refused && !text.trim()) await push(REFUSAL_TEXT);
      await flush();

      const citations = extractCitations(text, sources);
      if (toolLog.length) await sql`UPDATE messages SET tool_calls = ${sql.json(toolLog)} WHERE id = ${assistantMsg.id}`;
      const finished = await finishMessage(sql, job.tenantId, assistantMsg.id, text, citations, "complete");
      await emit(job.runId, ++seq, "message.completed", { message: toMessage(finished) });

      if (a.follow_ups && !refused && !handedOff) {
        const suggestions = await suggestFollowUps(this.models, { alias: aux, question: job.userMessage.content, answer: text, sources, signal });
        if (suggestions.length) {
          await sql`UPDATE messages SET suggestions = ${sql.json(suggestions)} WHERE id = ${assistantMsg.id}`;
          await emit(job.runId, ++seq, "message.suggestions", { messageId: assistantMsg.id, suggestions });
        }
      }

      await sql`
        UPDATE runs SET status = 'completed', finished_at = now(), deployment_id = ${deploymentId},
          input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens}, first_token_ms = ${firstTokenMs}
        WHERE id = ${job.runId}`;
      await emit(job.runId, ++seq, "run.completed", { usage });
      void emitWebhook(sql, job.tenantId, "message.completed", {
        conversationId: job.conversationId,
        widgetId: job.widgetId,
        assistantId: a.id,
        runId: job.runId,
        subject: job.subject,
        question: { id: job.userMessage.id, content: job.userMessage.content },
        answer: toMessage(finished),
        tools: toolLog,
        sourceCount: sources.length,
        deploymentId,
        usage,
      }).catch((err) => this.log.warn({ err }, "webhook enqueue failed"));
      metrics.runs.inc({ status: "completed", deployment: deploymentId ?? "none" });
      metrics.tokens.inc({ direction: "input", deployment: deploymentId ?? "none" }, usage.inputTokens);
      metrics.tokens.inc({ direction: "output", deployment: deploymentId ?? "none" }, usage.outputTokens);
      if (firstTokenMs !== null) metrics.ttft.observe(firstTokenMs, { deployment: deploymentId ?? "none" });
    } catch (err) {
      const cancelled = signal.aborted && String(signal.reason?.message) === "cancelled";
      const status = cancelled ? "cancelled" : "failed";
      const code = cancelled ? "cancelled" : err instanceof ModelError ? "model_error" : "internal_error";
      const publicMessage = cancelled
        ? "Cancelled."
        : err instanceof ModelError
          ? "The AI service is temporarily unavailable. Please try again in a moment."
          : signal.aborted
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

  /** Validate, confirm or delegate, run, and report one tool call. */
  private async runTool(
    job: RunJob,
    tools: Map<string, RunTool>,
    call: ToolCall,
    signal: AbortSignal,
    nextSeq: () => number,
  ): Promise<{ content: string; isError: boolean }> {
    const emit = this.bus.append.bind(this.bus);
    const tool = tools.get(call.name);
    if (!tool) return { content: `Unknown tool "${call.name}".`, isError: true };
    const invalid = validateArguments(tool.def.parameters, call.input);
    if (invalid) return { content: `Invalid arguments: ${invalid}`, isError: true };
    // Tool-call ids come from the model provider; namespace them for the public API.
    const callId = `call_${call.id.replace(/[^A-Za-z0-9_-]/g, "").slice(-40) || newId("call")}`;

    if (tool.kind === "client" || tool.confirm) {
      const kind = tool.kind === "client" ? "client" : "confirmation";
      await emit(job.runId, nextSeq(), "tool.input_required", {
        callId,
        name: call.name,
        title: tool.title,
        kind,
        input: call.input,
        timeoutMs: INPUT_TIMEOUT_MS,
      });
      const answer = await this.waitForInput(job.runId, callId, signal);
      if (!answer) {
        await emit(job.runId, nextSeq(), "tool.completed", { callId, name: call.name, isError: true });
        return {
          content: kind === "client" ? "The page did not respond (the visitor may have left)." : "The user did not confirm the action in time; it was not performed.",
          isError: true,
        };
      }
      if (kind === "client") {
        const isError = answer.isError === true;
        await emit(job.runId, nextSeq(), "tool.completed", { callId, name: call.name, isError });
        return { content: stringifyOutput(answer.output) || (isError ? "error" : "(no content)"), isError };
      }
      if (answer.approved !== true) {
        await emit(job.runId, nextSeq(), "tool.completed", { callId, name: call.name, isError: false });
        return { content: "The user declined this action. It was not performed. Ask how else you can help.", isError: false };
      }
    } else {
      await emit(job.runId, nextSeq(), "tool.started", { callId, name: call.name, title: tool.title });
    }
    let out: { content: string; isError: boolean };
    try {
      out = await tool.run!(call.input);
    } catch (err) {
      if (signal.aborted) throw err;
      out = { content: `Tool failed: ${(err as Error).message}`, isError: true };
    }
    metrics.tools.inc({ tool: tool.kind === "action" ? "action" : call.name, status: out.isError ? "error" : "ok" });
    await emit(job.runId, nextSeq(), "tool.completed", { callId, name: call.name, isError: out.isError });
    return out;
  }
}
