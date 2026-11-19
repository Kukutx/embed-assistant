/**
 * One grounded answer without a conversation: the same guardrails, retrieval,
 * prompt and knowledge search as a widget run, but no stored messages and no
 * side effects. Actions, MCP tools and page tools never run here; a handoff is
 * only recorded. Used by evaluations and the MCP `ask` tool.
 */
import type { Citation, GuardrailKind } from "@embed-assistant/protocol";
import type { Logger } from "pino";
import { guardrailsOf, type AssistantRow } from "../db/store.js";
import type { Sql } from "../db/pool.js";
import { retrieve } from "../knowledge/retrieve.js";
import { metrics } from "../lib/metrics.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ChatTurn, SourcePassage, TextTurn, ToolCall, ToolResult } from "../models/types.js";
import { auxAlias, contextualQuery } from "./assist.js";
import { AnswerWatch, checkQuestion, TermMatcher } from "./guardrails.js";
import { buildSystemPrompt, buildUserTurn, extractCitations } from "./prompt.js";
import { HANDOFF_TOOL, handoffToolDef, SEARCH_TOOL, searchToolDef } from "./tools.js";

const MAX_STEPS = 4;
const REFUSAL_TEXT = "Sorry, I can't help with that request.";

export interface AnswerDeps {
  sql: Sql;
  models: ModelRegistry;
  log: Logger;
}

export interface AnswerInput {
  tenantId: string;
  assistant: AssistantRow;
  question: string;
  /** Access groups for retrieval (always includes `public`). */
  access: string[];
  history?: TextTurn[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  sources: SourcePassage[];
  guardrail: { kind: GuardrailKind; detail: string } | null;
  /** The model asked to hand over to a person. */
  handoff: boolean;
  refused: boolean;
  usage: { inputTokens: number; outputTokens: number };
  deploymentId: string | null;
  latencyMs: number;
}

/**
 * Extra knowledge searches append passages with new numbers so earlier
 * citations stay valid. Returns the text for the model and the new passages.
 */
export function knowledgeSearch(sources: SourcePassage[], find: (q: string) => Promise<SourcePassage[]>, max = 30) {
  const seen = new Set(sources.map((x) => `${x.documentId}:${x.content.slice(0, 200)}`));
  return async (q: string): Promise<{ text: string; fresh: SourcePassage[] }> => {
    const found = await find(q.slice(0, 300));
    const fresh: SourcePassage[] = [];
    for (const f of found) {
      const k = `${f.documentId}:${f.content.slice(0, 200)}`;
      if (seen.has(k) || sources.length + fresh.length >= max) continue;
      seen.add(k);
      fresh.push({ ...f, index: sources.length + fresh.length + 1 });
    }
    sources.push(...fresh);
    if (!fresh.length) return { text: found.length ? "No new passages (the results were already provided as sources)." : "No matching passages found.", fresh };
    return { text: buildUserTurn({ question: "", sources: fresh, context: undefined }).replace(/\n\nQuestion: $/, ""), fresh };
  };
}

export async function answerOnce(deps: AnswerDeps, p: AnswerInput): Promise<AnswerResult> {
  const started = Date.now();
  const signal = p.signal ?? AbortSignal.timeout(120_000);
  const a = p.assistant;
  const g = guardrailsOf(a);
  const terms = new TermMatcher(g.blockedTerms);
  const history = p.history ?? [];
  const aux = auxAlias(deps.models, a.model_alias);
  const access = [...new Set(["public", ...p.access])];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const result = (over: Partial<AnswerResult>): AnswerResult => ({
    answer: "",
    citations: [],
    sources: [],
    guardrail: null,
    handoff: false,
    refused: false,
    usage,
    deploymentId: null,
    latencyMs: Date.now() - started,
    ...over,
  });

  const find = (q: string) => retrieve(deps.sql, deps.models.embeddings, deps.log, { tenantId: p.tenantId, sourceIds: a.source_ids, access, query: q });
  const lastUser = [...history].reverse().find((t) => t.role === "user")?.content;
  const [blocked, sources] = await Promise.all([
    checkQuestion(deps, { alias: aux, question: p.question, previous: lastUser, guardrails: g, terms, signal }),
    (async () => {
      if (!a.source_ids.length || terms.find(p.question)) return [] as SourcePassage[];
      const q = await contextualQuery(deps.models, { alias: aux, question: p.question, history, useModel: a.query_rewrite, signal });
      return find(q);
    })(),
  ]);
  if (blocked) return result({ answer: blocked.message, guardrail: { kind: blocked.kind, detail: blocked.detail }, refused: true });

  const search = knowledgeSearch(sources, find);
  const canUseTools = deps.models.hasLanguageModel(a.model_alias);
  const tools = [
    ...(canUseTools && a.agentic_search && a.source_ids.length ? [searchToolDef] : []),
    ...(canUseTools && a.handoff.enabled ? [handoffToolDef] : []),
  ];
  const system = buildSystemPrompt({
    assistantName: a.name,
    instructions: a.instructions,
    groundedOnly: a.grounded_only,
    tools: tools.length ? { search: tools.includes(searchToolDef), handoff: tools.includes(handoffToolDef), actions: false } : undefined,
  });
  const transcript: ChatTurn[] = [...history, { role: "user", content: buildUserTurn({ question: p.question, sources, context: undefined }) }];

  const watch = new AnswerWatch(terms);
  let text = "";
  let deploymentId: string | null = null;
  let handoff = false;
  let refused = false;
  let answerTerm: string | null = null;
  for (let step = 0; step < MAX_STEPS && !answerTerm; step++) {
    const lastStep = step === MAX_STEPS - 1;
    let stepText = "";
    const calls: ToolCall[] = [];
    let raw: { provider: string; content: unknown } | undefined;
    for await (const { deploymentId: dep, chunk } of deps.models.stream(a.model_alias, {
      system,
      messages: transcript,
      question: p.question,
      sources,
      maxOutputTokens: p.maxOutputTokens ?? 2048,
      signal,
      ...(tools.length && !lastStep ? { tools } : {}),
    })) {
      deploymentId = dep;
      if (chunk.type === "text") {
        const piece = (stepText === "" && text && !text.endsWith("\n") ? "\n\n" : "") + chunk.text;
        stepText += chunk.text;
        text += piece;
        if (g.checkAnswers && (answerTerm = watch.push(piece))) break;
      } else if (chunk.type === "usage") {
        usage.inputTokens += chunk.inputTokens;
        usage.outputTokens += chunk.outputTokens;
      } else if (chunk.type === "refusal") refused = true;
      else if (chunk.type === "tool_call") calls.push(chunk.call);
      else if (chunk.type === "raw") raw = { provider: chunk.provider, content: chunk.content };
    }
    if (!calls.length || refused || answerTerm) break;
    transcript.push({ role: "assistant", content: stepText, toolCalls: calls, ...(raw ? { raw } : {}) });
    const results: ToolResult[] = [];
    for (const call of calls) {
      let content: string;
      if (call.name === SEARCH_TOOL) content = (await search(String(call.input.query ?? ""))).text;
      else if (call.name === HANDOFF_TOOL) {
        handoff = true;
        content = `The team has been notified. The user will see this message: "${a.handoff.message}". Do not repeat any link.`;
      } else content = `Unknown tool "${call.name}".`;
      results.push({ callId: call.id, name: call.name, content, isError: false });
    }
    transcript.push({ role: "tool", results });
  }
  if (answerTerm) {
    metrics.guardrails.inc({ result: "blocked", rule: "answer_term" });
    return result({ answer: g.refusalMessage, sources, guardrail: { kind: "answer_term", detail: answerTerm }, refused: true, deploymentId, handoff });
  }
  if (refused && !text.trim()) text = REFUSAL_TEXT;
  return result({ answer: text.trim(), citations: extractCitations(text, sources), sources, handoff, refused, deploymentId });
}
