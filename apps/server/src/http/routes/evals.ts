/** Evaluation suites: questions with expectations, run against an assistant to score answers and catch regressions. */
import type { Context, Hono } from "hono";
import {
  EvalCase,
  EvalCaseList,
  EvalCasePatch,
  EvalCasesInput,
  EvalRun,
  EvalRunDetail,
  EvalRunInput,
  EvalRunList,
  EvalSuite,
  EvalSuiteInput,
  EvalSuiteList,
  EvalSuitePatch,
} from "@embed-assistant/protocol";
import { getAssistant } from "../../db/store.js";
import {
  addCases,
  createRun,
  createSuite,
  deleteCase,
  deleteSuite,
  getRun,
  getSuite,
  lastRunOf,
  listCases,
  listRuns,
  listSuites,
  runResults,
  toEvalCase,
  toEvalRun,
  toEvalSuite,
  updateCase,
  updateSuite,
  type SuiteRow,
} from "../../evals/evals.js";
import { enqueueJob } from "../../knowledge/jobs.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { param, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";

export function evalRoutes(app: Hono<AppEnv>, s: Services): void {
  const { sql } = s;
  const T = "Admin: evaluations";
  const tid = (c: Context<AppEnv>) => c.get("tenantId");

  async function suiteOr404(c: Context<AppEnv>): Promise<SuiteRow> {
    const suite = await getSuite(sql, tid(c), param(c, "id"));
    if (!suite) throw notFound("evaluation suite");
    return suite;
  }
  async function assistantOr400(c: Context<AppEnv>, id: string) {
    const a = await getAssistant(sql, tid(c), id);
    if (!a) throw badRequest(`assistant ${id} not found`);
    return a;
  }

  route(app, { method: "get", path: "/v1/admin/evals", tag: T, summary: "List evaluation suites", auth: "admin", response: { status: 200, schema: EvalSuiteList } },
    async (c) => c.json({ items: await listSuites(sql, tid(c)) }));

  route(app, {
      method: "post", path: "/v1/admin/evals", tag: T, summary: "Create an evaluation suite",
      description: "A suite belongs to an assistant. Add cases, then start a run to score the assistant's answers.",
      auth: "admin", body: EvalSuiteInput, response: { status: 201, schema: EvalSuite },
    },
    async (c, { body }) => {
      await assistantOr400(c, body.assistantId);
      return c.json(toEvalSuite(await createSuite(sql, tid(c), body), null), 201);
    });

  route(app, { method: "get", path: "/v1/admin/evals/{id}", tag: T, summary: "Get an evaluation suite", auth: "admin", response: { status: 200, schema: EvalSuite } },
    async (c) => {
      const suite = await suiteOr404(c);
      return c.json(toEvalSuite(suite, await lastRunOf(sql, suite.id)));
    });

  route(app, { method: "patch", path: "/v1/admin/evals/{id}", tag: T, summary: "Update an evaluation suite", auth: "admin", body: EvalSuitePatch, response: { status: 200, schema: EvalSuite } },
    async (c, { body }) => {
      if (body.assistantId) await assistantOr400(c, body.assistantId);
      const suite = await updateSuite(sql, tid(c), param(c, "id"), body);
      if (!suite) throw notFound("evaluation suite");
      return c.json(toEvalSuite(suite, await lastRunOf(sql, suite.id)));
    });

  route(app, { method: "delete", path: "/v1/admin/evals/{id}", tag: T, summary: "Delete an evaluation suite with its cases and runs", auth: "admin", response: { status: 204 } },
    async (c) => {
      if (!(await deleteSuite(sql, tid(c), param(c, "id")))) throw notFound("evaluation suite");
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ cases
  route(app, { method: "get", path: "/v1/admin/evals/{id}/cases", tag: T, summary: "List the cases of a suite", auth: "admin", response: { status: 200, schema: EvalCaseList } },
    async (c) => {
      const suite = await suiteOr404(c);
      return c.json({ items: (await listCases(sql, suite.id)).map(toEvalCase) });
    });

  route(app, {
      method: "post", path: "/v1/admin/evals/{id}/cases", tag: T, summary: "Add cases (one or an import of up to 500)",
      auth: "admin", body: EvalCasesInput, response: { status: 201, schema: EvalCaseList },
    },
    async (c, { body }) => {
      const suite = await suiteOr404(c);
      return c.json({ items: (await addCases(sql, suite, body.cases)).map(toEvalCase) }, 201);
    });

  route(app, { method: "patch", path: "/v1/admin/evals/{id}/cases/{caseId}", tag: T, summary: "Update a case", auth: "admin", body: EvalCasePatch, response: { status: 200, schema: EvalCase } },
    async (c, { body }) => {
      const suite = await suiteOr404(c);
      const row = await updateCase(sql, suite.id, param(c, "caseId"), body);
      if (!row) throw notFound("case");
      return c.json(toEvalCase(row));
    });

  route(app, { method: "delete", path: "/v1/admin/evals/{id}/cases/{caseId}", tag: T, summary: "Delete a case", auth: "admin", response: { status: 204 } },
    async (c) => {
      const suite = await suiteOr404(c);
      if (!(await deleteCase(sql, suite.id, param(c, "caseId")))) throw notFound("case");
      return c.body(null, 204);
    });

  // ------------------------------------------------------------------ runs
  route(app, {
      method: "post", path: "/v1/admin/evals/{id}/runs", tag: T, summary: "Run the suite",
      description:
        "Answers every case in the background (no conversations are created and no actions, MCP or page tools run; a handoff is only recorded), " +
        "then scores it. Pass another `assistantId` to compare a changed copy of the assistant on the same cases. Uses model tokens.",
      auth: "admin", body: EvalRunInput, response: { status: 202, schema: EvalRun },
    },
    async (c, { body }) => {
      const suite = await suiteOr404(c);
      if (!Number(suite.case_count)) throw badRequest("the suite has no cases");
      const active = await sql`SELECT 1 FROM eval_runs WHERE suite_id = ${suite.id} AND status IN ('queued', 'running') LIMIT 1`;
      if (active.length) throw conflict("a run of this suite is already in progress");
      const a = await assistantOr400(c, body.assistantId ?? suite.assistant_id);
      const actor = c.get("actor");
      const run = await createRun(sql, { suite, assistantId: a.id, assistantVersion: a.version, judge: body.judge, createdBy: actor.name ?? actor.email ?? actor.id });
      await enqueueJob(sql, suite.tenant_id, "run_eval", { runId: run.id });
      return c.json(toEvalRun(run), 202);
    });

  route(app, { method: "get", path: "/v1/admin/evals/{id}/runs", tag: T, summary: "List runs of a suite (latest first)", auth: "admin", response: { status: 200, schema: EvalRunList } },
    async (c) => {
      const suite = await suiteOr404(c);
      return c.json({ items: (await listRuns(sql, suite.id)).map(toEvalRun) });
    });

  route(app, {
      method: "get", path: "/v1/admin/eval-runs/{id}", tag: T, summary: "Get a run with per-case results",
      description: "Each result includes the same case's outcome in the previous completed run (`previous`), to spot regressions.",
      auth: "admin", response: { status: 200, schema: EvalRunDetail },
    },
    async (c) => {
      const run = await getRun(sql, tid(c), param(c, "id"));
      if (!run) throw notFound("evaluation run");
      return c.json({ ...toEvalRun(run), ...(await runResults(sql, run)) });
    });

  route(app, { method: "post", path: "/v1/admin/eval-runs/{id}/cancel", tag: T, summary: "Cancel a run in progress", auth: "admin", response: { status: 200, schema: EvalRun } },
    async (c) => {
      await sql`UPDATE eval_runs SET status = 'cancelled', finished_at = now() WHERE tenant_id = ${tid(c)} AND id = ${param(c, "id")} AND status IN ('queued', 'running')`;
      const run = await getRun(sql, tid(c), param(c, "id"));
      if (!run) throw notFound("evaluation run");
      return c.json(toEvalRun(run));
    });
}
