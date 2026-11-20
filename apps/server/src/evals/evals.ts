/**
 * Evaluations: suites of questions with expectations, run against an
 * assistant to measure answer quality and catch regressions after a change of
 * instructions, model, knowledge or guardrails.
 *
 * A run is a background job (`run_eval`). It answers each case with
 * answerOnce (no conversations, no side effects), scores it with
 * deterministic checks and, for cases with a reference answer, a model judge,
 * and stores one result per case. A crashed worker resumes where it stopped.
 */
import type { EvalCase, EvalCaseInput, EvalOutcome, EvalResult, EvalRun, EvalSuite, GuardrailKind } from "@embed-assistant/protocol";
import type { Logger } from "pino";
import type { Sql } from "../db/pool.js";
import { getAssistant } from "../db/store.js";
import type { JobRow } from "../knowledge/jobs.js";
import { queryTokens } from "../knowledge/tokenize.js";
import { badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { metrics } from "../lib/metrics.js";
import { iso, isoOrNull } from "../lib/time.js";
import type { ModelRegistry } from "../models/registry.js";
import { getVersion, rowAtVersion } from "../assistants/versions.js";
import { auxAlias } from "../runs/assist.js";
import { answerOnce, type AnswerResult } from "../runs/answer.js";

export const MAX_CASES_PER_SUITE = 500;
const CONCURRENCY = 4;
const CASE_TIMEOUT_MS = 90_000;
/** A judged answer passes at 4 of 5. */
const JUDGE_PASS = 0.75;
const LEXICAL_PASS = 0.6;

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

export interface SuiteRow {
  id: string;
  tenant_id: string;
  assistant_id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  case_count?: string;
}

export interface CaseRow {
  id: string;
  suite_id: string;
  tenant_id: string;
  question: string;
  expected_answer: string | null;
  must_include: string[];
  must_not_include: string[];
  expected_sources: string[];
  expected_outcome: EvalOutcome | null;
  access: string[];
  tags: string[];
  history: { role: "user" | "assistant"; content: string }[];
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  suite_id: string;
  assistant_id: string;
  assistant_version: number;
  pinned_version: boolean;
  status: EvalRun["status"];
  judge: boolean;
  total: number;
  error: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  completed?: string;
  passed?: string;
  score?: number | null;
  input_tokens?: string;
  output_tokens?: string;
}

interface ResultRow {
  run_id: string;
  case_id: string;
  question: string;
  answer: string;
  citations: EvalResult["citations"];
  outcome: EvalOutcome;
  guardrail: GuardrailKind | null;
  passed: boolean;
  score: number;
  checks: EvalResult["checks"];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
  prev_passed?: boolean | null;
  prev_score?: number | null;
}

export const toEvalCase = (r: CaseRow): EvalCase => ({
  id: r.id,
  question: r.question,
  expectedAnswer: r.expected_answer,
  mustInclude: r.must_include,
  mustNotInclude: r.must_not_include,
  expectedSources: r.expected_sources,
  expectedOutcome: r.expected_outcome,
  access: r.access,
  tags: r.tags,
  history: r.history ?? [],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toEvalRun = (r: RunRow): EvalRun => ({
  id: r.id,
  suiteId: r.suite_id,
  assistantId: r.assistant_id,
  assistantVersion: r.assistant_version,
  pinnedVersion: r.pinned_version,
  status: r.status,
  total: r.total,
  completed: Number(r.completed ?? 0),
  passed: Number(r.passed ?? 0),
  score: r.score === null || r.score === undefined ? null : Math.round(Number(r.score) * 1000) / 1000,
  judge: r.judge,
  inputTokens: Number(r.input_tokens ?? 0),
  outputTokens: Number(r.output_tokens ?? 0),
  error: r.error,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  startedAt: isoOrNull(r.started_at),
  finishedAt: isoOrNull(r.finished_at),
});

export const toEvalSuite = (r: SuiteRow, lastRun: RunRow | null): EvalSuite => ({
  id: r.id,
  name: r.name,
  description: r.description,
  assistantId: r.assistant_id,
  caseCount: Number(r.case_count ?? 0),
  lastRun: lastRun ? toEvalRun(lastRun) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toEvalResult = (r: ResultRow): EvalResult => ({
  caseId: r.case_id,
  question: r.question,
  answer: r.answer,
  citations: r.citations,
  outcome: r.outcome,
  guardrail: r.guardrail,
  passed: r.passed,
  score: Math.round(r.score * 1000) / 1000,
  checks: r.checks,
  latencyMs: r.latency_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  error: r.error,
  previous: r.prev_passed === null || r.prev_passed === undefined ? null : { passed: r.prev_passed, score: Math.round(Number(r.prev_score ?? 0) * 1000) / 1000 },
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Run columns with aggregates over its results. */
const RUN_SELECT = (sql: Sql) => sql`
  r.*,
  (SELECT count(*) FROM eval_results x WHERE x.run_id = r.id) AS completed,
  (SELECT count(*) FILTER (WHERE x.passed) FROM eval_results x WHERE x.run_id = r.id) AS passed,
  (SELECT avg(x.score) FROM eval_results x WHERE x.run_id = r.id) AS score,
  (SELECT coalesce(sum(x.input_tokens), 0) FROM eval_results x WHERE x.run_id = r.id) AS input_tokens,
  (SELECT coalesce(sum(x.output_tokens), 0) FROM eval_results x WHERE x.run_id = r.id) AS output_tokens`;

export async function listSuites(sql: Sql, tenantId: string): Promise<EvalSuite[]> {
  const suites = await sql<SuiteRow[]>`
    SELECT s.*, (SELECT count(*) FROM eval_cases c WHERE c.suite_id = s.id) AS case_count
    FROM eval_suites s WHERE s.tenant_id = ${tenantId} ORDER BY s.created_at`;
  if (!suites.length) return [];
  const runs = await sql<RunRow[]>`
    SELECT DISTINCT ON (r.suite_id) ${RUN_SELECT(sql)}
    FROM eval_runs r WHERE r.tenant_id = ${tenantId} ORDER BY r.suite_id, r.created_at DESC`;
  const last = new Map(runs.map((r) => [r.suite_id, r]));
  return suites.map((s) => toEvalSuite(s, last.get(s.id) ?? null));
}

export async function getSuite(sql: Sql, tenantId: string, id: string): Promise<SuiteRow | null> {
  const [row] = await sql<SuiteRow[]>`
    SELECT s.*, (SELECT count(*) FROM eval_cases c WHERE c.suite_id = s.id) AS case_count
    FROM eval_suites s WHERE s.tenant_id = ${tenantId} AND s.id = ${id}`;
  return row ?? null;
}

export async function lastRunOf(sql: Sql, suiteId: string): Promise<RunRow | null> {
  const [row] = await sql<RunRow[]>`SELECT ${RUN_SELECT(sql)} FROM eval_runs r WHERE r.suite_id = ${suiteId} ORDER BY r.created_at DESC LIMIT 1`;
  return row ?? null;
}

export async function createSuite(sql: Sql, tenantId: string, input: { name: string; description: string; assistantId: string }): Promise<SuiteRow> {
  const [row] = await sql<SuiteRow[]>`
    INSERT INTO eval_suites (id, tenant_id, assistant_id, name, description)
    VALUES (${newId("evs")}, ${tenantId}, ${input.assistantId}, ${input.name}, ${input.description})
    RETURNING *, 0 AS case_count`;
  return row!;
}

export async function updateSuite(sql: Sql, tenantId: string, id: string, patch: { name?: string | undefined; description?: string | undefined; assistantId?: string | undefined }): Promise<SuiteRow | null> {
  const [row] = await sql<SuiteRow[]>`
    UPDATE eval_suites SET
      name = coalesce(${patch.name ?? null}, name),
      description = coalesce(${patch.description ?? null}, description),
      assistant_id = coalesce(${patch.assistantId ?? null}, assistant_id),
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}
    RETURNING *, (SELECT count(*) FROM eval_cases c WHERE c.suite_id = eval_suites.id) AS case_count`;
  return row ?? null;
}

export async function deleteSuite(sql: Sql, tenantId: string, id: string): Promise<boolean> {
  return (await sql`DELETE FROM eval_suites WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`).length > 0;
}

export async function listCases(sql: Sql, suiteId: string): Promise<CaseRow[]> {
  return sql<CaseRow[]>`SELECT * FROM eval_cases WHERE suite_id = ${suiteId} ORDER BY created_at, id`;
}

export async function addCases(sql: Sql, suite: SuiteRow, cases: EvalCaseInput[]): Promise<CaseRow[]> {
  return sql.begin(async (tx) => {
    // Serialize concurrent imports into the same suite so the cap holds.
    await tx`SELECT id FROM eval_suites WHERE id = ${suite.id} FOR UPDATE`;
    const n = Number((await tx<{ n: string }[]>`SELECT count(*) AS n FROM eval_cases WHERE suite_id = ${suite.id}`)[0]?.n ?? 0);
    if (n + cases.length > MAX_CASES_PER_SUITE) throw badRequest(`a suite holds at most ${MAX_CASES_PER_SUITE} cases (it has ${n})`);
    const out: CaseRow[] = [];
    for (const c of cases) {
      const [row] = await tx<CaseRow[]>`
        INSERT INTO eval_cases (id, suite_id, tenant_id, question, expected_answer, must_include, must_not_include,
                                expected_sources, expected_outcome, access, tags, history)
        VALUES (${newId("evc")}, ${suite.id}, ${suite.tenant_id}, ${c.question}, ${c.expectedAnswer},
                ${tx.json(c.mustInclude)}, ${tx.json(c.mustNotInclude)}, ${tx.json(c.expectedSources)},
                ${c.expectedOutcome}, ${tx.array(c.access)}, ${tx.json(c.tags)}, ${tx.json(c.history as never)})
        RETURNING *`;
      out.push(row!);
    }
    await tx`UPDATE eval_suites SET updated_at = now() WHERE id = ${suite.id}`;
    return out;
  }) as Promise<CaseRow[]>;
}

export async function updateCase(sql: Sql, suiteId: string, caseId: string, patch: Partial<EvalCaseInput>): Promise<CaseRow | null> {
  const [cur] = await sql<CaseRow[]>`SELECT * FROM eval_cases WHERE suite_id = ${suiteId} AND id = ${caseId}`;
  if (!cur) return null;
  const n = {
    question: patch.question ?? cur.question,
    expectedAnswer: patch.expectedAnswer !== undefined ? patch.expectedAnswer : cur.expected_answer,
    mustInclude: patch.mustInclude ?? cur.must_include,
    mustNotInclude: patch.mustNotInclude ?? cur.must_not_include,
    expectedSources: patch.expectedSources ?? cur.expected_sources,
    expectedOutcome: patch.expectedOutcome !== undefined ? patch.expectedOutcome : cur.expected_outcome,
    access: patch.access ?? cur.access,
    tags: patch.tags ?? cur.tags,
    history: patch.history ?? cur.history,
  };
  const [row] = await sql<CaseRow[]>`
    UPDATE eval_cases SET question = ${n.question}, expected_answer = ${n.expectedAnswer},
      must_include = ${sql.json(n.mustInclude)}, must_not_include = ${sql.json(n.mustNotInclude)},
      expected_sources = ${sql.json(n.expectedSources)}, expected_outcome = ${n.expectedOutcome},
      access = ${sql.array(n.access)}, tags = ${sql.json(n.tags)}, history = ${sql.json(n.history as never)}, updated_at = now()
    WHERE suite_id = ${suiteId} AND id = ${caseId} RETURNING *`;
  return row ?? null;
}

export async function deleteCase(sql: Sql, suiteId: string, caseId: string): Promise<boolean> {
  return (await sql`DELETE FROM eval_cases WHERE suite_id = ${suiteId} AND id = ${caseId} RETURNING id`).length > 0;
}

export async function createRun(
  sql: Sql,
  p: { suite: SuiteRow; assistantId: string; assistantVersion: number; pinned: boolean; judge: boolean; createdBy: string | null },
): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    INSERT INTO eval_runs (id, tenant_id, suite_id, assistant_id, assistant_version, pinned_version, judge, total, created_by)
    VALUES (${newId("evr")}, ${p.suite.tenant_id}, ${p.suite.id}, ${p.assistantId}, ${p.assistantVersion}, ${p.pinned}, ${p.judge},
            (SELECT count(*) FROM eval_cases WHERE suite_id = ${p.suite.id}), ${p.createdBy})
    RETURNING *`;
  return row!;
}

export async function getRun(sql: Sql, tenantId: string, id: string): Promise<RunRow | null> {
  const [row] = await sql<RunRow[]>`SELECT ${RUN_SELECT(sql)} FROM eval_runs r WHERE r.tenant_id = ${tenantId} AND r.id = ${id}`;
  return row ?? null;
}

export async function listRuns(sql: Sql, suiteId: string, limit = 50): Promise<RunRow[]> {
  return sql<RunRow[]>`SELECT ${RUN_SELECT(sql)} FROM eval_runs r WHERE r.suite_id = ${suiteId} ORDER BY r.created_at DESC LIMIT ${limit}`;
}

/** Results of a run, each with the same case's result in the previous completed run. */
export async function runResults(sql: Sql, run: RunRow): Promise<{ previousRunId: string | null; results: EvalResult[] }> {
  const [prev] = await sql<{ id: string }[]>`
    SELECT id FROM eval_runs WHERE suite_id = ${run.suite_id} AND status = 'completed' AND created_at < ${run.created_at}
    ORDER BY created_at DESC LIMIT 1`;
  const rows = await sql<ResultRow[]>`
    SELECT x.*, p.passed AS prev_passed, p.score AS prev_score
    FROM eval_results x
    LEFT JOIN eval_results p ON p.run_id = ${prev?.id ?? ""} AND p.case_id = x.case_id
    LEFT JOIN eval_cases c ON c.id = x.case_id
    WHERE x.run_id = ${run.id}
    ORDER BY c.created_at NULLS LAST, x.case_id`;
  return { previousRunId: prev?.id ?? null, results: rows.map(toEvalResult) };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type Check = EvalResult["checks"][number];
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

export function outcomeOf(r: Pick<AnswerResult, "guardrail" | "refused" | "handoff">): EvalOutcome {
  if (r.guardrail || r.refused) return "refuse";
  return r.handoff ? "handoff" : "answer";
}

/** Does an expected-source entry match a citation (URL, document id, or part of the title)? */
function sourceMatches(entry: string, c: { documentId: string; title: string; url: string | null }): boolean {
  const e = norm(entry.trim());
  if (c.documentId.toLowerCase() === e) return true;
  const url = c.url ? norm(c.url).replace(/\/+$/, "") : null;
  if (url && /^https?:\/\//.test(e)) {
    const want = e.replace(/\/+$/, "");
    return url === want || url.startsWith(`${want}#`) || url.startsWith(`${want}?`);
  }
  if (url?.includes(e)) return true;
  return norm(c.title).includes(e);
}

/** Share of the reference answer's key terms found in the answer (used without a judge model). */
export function lexicalRecall(answer: string, reference: string): number {
  const want = [...new Set(queryTokens(reference))];
  if (!want.length) return 1;
  const have = new Set(queryTokens(answer));
  return want.filter((t) => have.has(t)).length / want.length;
}

export function deterministicChecks(c: CaseRow, r: Pick<AnswerResult, "answer" | "citations" | "guardrail" | "refused" | "handoff">): Check[] {
  const checks: Check[] = [];
  const text = norm(r.answer);
  if (c.must_include.length) {
    const missing = c.must_include.filter((p) => !text.includes(norm(p)));
    checks.push({
      name: "must_include",
      passed: missing.length === 0,
      score: 1 - missing.length / c.must_include.length,
      detail: missing.length ? `missing: ${missing.join(", ")}` : null,
    });
  }
  if (c.must_not_include.length) {
    const found = c.must_not_include.filter((p) => text.includes(norm(p)));
    checks.push({
      name: "must_not_include",
      passed: found.length === 0,
      score: 1 - found.length / c.must_not_include.length,
      detail: found.length ? `found: ${found.join(", ")}` : null,
    });
  }
  if (c.expected_sources.length) {
    const missing = c.expected_sources.filter((e) => !r.citations.some((x) => sourceMatches(e, x)));
    checks.push({
      name: "sources",
      passed: missing.length === 0,
      score: 1 - missing.length / c.expected_sources.length,
      detail: missing.length ? `not cited: ${missing.join(", ")}` : null,
    });
  }
  if (c.expected_outcome) {
    const got = outcomeOf(r);
    checks.push({ name: "outcome", passed: got === c.expected_outcome, score: got === c.expected_outcome ? 1 : 0, detail: got === c.expected_outcome ? null : `expected ${c.expected_outcome}, got ${got}` });
  }
  return checks;
}

const JUDGE_SYSTEM =
  "You grade answers of a customer-facing AI assistant against a reference answer written by the site owner. " +
  "Score how well the answer conveys the reference's facts: correctness first (contradicting the reference is a fail), " +
  "then completeness. Extra correct detail, different wording, language or formatting do not lower the score. " +
  "5 = fully correct and complete; 4 = correct, minor omission; 3 = partly correct or missing key facts; 2 = mostly wrong or unhelpful; 1 = wrong or contradicts the reference.\n" +
  "Reply with exactly two lines:\nSCORE: <1-5>\nREASON: <one short sentence>";

export async function judgeAnswer(
  models: ModelRegistry,
  p: { alias: string; question: string; reference: string; answer: string; signal?: AbortSignal },
): Promise<Check> {
  const out = await models.complete(p.alias, {
    system: JUDGE_SYSTEM,
    prompt: `<question>\n${p.question}\n</question>\n\n<reference>\n${p.reference}\n</reference>\n\n<answer>\n${p.answer.slice(0, 8000)}\n</answer>`,
    maxOutputTokens: 120,
    timeoutMs: 20_000,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  const m = out ? /score\s*[:=]\s*([1-5])/i.exec(out) : null;
  if (m) {
    const score = (Number(m[1]) - 1) / 4;
    const reason = /reason\s*[:=]\s*(.+)/i.exec(out!)?.[1]?.trim() ?? null;
    return { name: "judge", passed: score >= JUDGE_PASS, score, detail: reason ? reason.slice(0, 300) : `score ${m[1]}/5` };
  }
  // No judge model (or an unusable reply): compare key terms instead.
  const recall = lexicalRecall(p.answer, p.reference);
  return { name: "judge", passed: recall >= LEXICAL_PASS, score: recall, detail: `lexical match ${Math.round(recall * 100)}% (no judge model)` };
}

export function summarize(checks: Check[], error: string | null, answer: string): { passed: boolean; score: number } {
  if (error) return { passed: false, score: 0 };
  if (!checks.length) return { passed: answer.trim().length > 0, score: answer.trim() ? 1 : 0 };
  return { passed: checks.every((c) => c.passed), score: checks.reduce((n, c) => n + c.score, 0) / checks.length };
}

// ---------------------------------------------------------------------------
// Runner (job handler)
// ---------------------------------------------------------------------------

export interface EvalDeps {
  sql: Sql;
  models: ModelRegistry;
  log: Logger;
}

export async function runEvalJob(deps: EvalDeps, job: JobRow): Promise<void> {
  const { sql, log } = deps;
  const runId = String(job.payload.runId);
  const [run] = await sql<RunRow[]>`SELECT * FROM eval_runs WHERE id = ${runId}`;
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
  try {
    const current = await getAssistant(sql, run.tenant_id, run.assistant_id);
    if (!current) throw new Error("assistant was deleted");
    let assistant = current;
    if (run.pinned_version) {
      const saved = await getVersion(sql, run.tenant_id, run.assistant_id, run.assistant_version);
      if (!saved) throw new Error(`version ${run.assistant_version} is not in the assistant's history`);
      assistant = rowAtVersion(current, saved.config, saved.version);
    }
    await sql`UPDATE eval_runs SET status = 'running', started_at = coalesce(started_at, now()), assistant_version = ${assistant.version} WHERE id = ${runId}`;
    const cases = await sql<CaseRow[]>`
      SELECT * FROM eval_cases WHERE suite_id = ${run.suite_id} AND created_at <= ${run.created_at}
        AND id NOT IN (SELECT case_id FROM eval_results WHERE run_id = ${runId})
      ORDER BY created_at, id`;
    const judgeAlias = deps.models.hasAlias("judge") ? "judge" : auxAlias(deps.models, assistant.model_alias);
    let next = 0;
    let stopped = false;
    let lastBeat = Date.now();
    const beat = async () => {
      if (Date.now() - lastBeat < 10_000) return;
      lastBeat = Date.now();
      // Keep the job's lock fresh, and notice a cancel.
      await sql`UPDATE jobs SET locked_at = now() WHERE id = ${job.id}`;
      const [s] = await sql<{ status: string }[]>`SELECT status FROM eval_runs WHERE id = ${runId}`;
      if (s?.status === "cancelled") stopped = true;
    };
    const worker = async () => {
      while (!stopped && next < cases.length) {
        const c = cases[next++]!;
        const started = Date.now();
        let r: AnswerResult | null = null;
        let error: string | null = null;
        const signal = AbortSignal.timeout(CASE_TIMEOUT_MS);
        try {
          r = await answerOnce(deps, { tenantId: run.tenant_id, assistant, question: c.question, access: c.access, history: c.history ?? [], signal });
        } catch (err) {
          error = signal.aborted ? "timed out" : ((err as Error).message ?? String(err)).slice(0, 500);
        }
        const checks = r ? deterministicChecks(c, r) : [];
        if (r && c.expected_answer) {
          checks.push(
            run.judge
              ? await judgeAnswer(deps.models, { alias: judgeAlias, question: c.question, reference: c.expected_answer, answer: r.answer })
              : (() => {
                  const recall = lexicalRecall(r.answer, c.expected_answer);
                  return { name: "judge" as const, passed: recall >= LEXICAL_PASS, score: recall, detail: `lexical match ${Math.round(recall * 100)}%` };
                })(),
          );
        }
        const { passed, score } = summarize(checks, error, r?.answer ?? "");
        metrics.evals.inc({ result: error ? "error" : passed ? "passed" : "failed" });
        const citations = (r?.citations ?? []).map((x) => ({ index: x.index, title: x.title, url: x.url, documentId: x.documentId }));
        await sql`
          INSERT INTO eval_results (run_id, case_id, question, answer, citations, outcome, guardrail, passed, score, checks,
                                    latency_ms, input_tokens, output_tokens, error)
          VALUES (${runId}, ${c.id}, ${c.question}, ${r?.answer ?? ""}, ${sql.json(citations)}, ${r ? outcomeOf(r) : "answer"},
                  ${r?.guardrail?.kind ?? null}, ${passed}, ${score}, ${sql.json(checks as never)}, ${Date.now() - started},
                  ${r?.usage.inputTokens ?? 0}, ${r?.usage.outputTokens ?? 0}, ${error})
          ON CONFLICT DO NOTHING`;
        await beat();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));
    await sql`UPDATE eval_runs SET status = 'completed', finished_at = now() WHERE id = ${runId} AND status = 'running'`;
  } catch (err) {
    log.warn({ run: runId, err: (err as Error).message }, "evaluation failed");
    await sql`UPDATE eval_runs SET status = 'failed', error = ${(err as Error).message.slice(0, 1000)}, finished_at = now() WHERE id = ${runId} AND status IN ('queued', 'running')`;
  }
}
