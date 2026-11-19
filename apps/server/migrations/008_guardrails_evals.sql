-- 1.0.7: guardrails (blocked terms and topics, moderation, prompt-injection
-- detection) and evaluation suites.
ALTER TABLE assistants ADD COLUMN guardrails jsonb NOT NULL DEFAULT '{}';

-- Which rule stopped an answer, and what matched (a term, a topic, a category).
ALTER TABLE runs
  ADD COLUMN guardrail        text,
  ADD COLUMN guardrail_detail text;
CREATE INDEX runs_guardrail ON runs (tenant_id, created_at) WHERE guardrail IS NOT NULL;

CREATE TABLE eval_suites (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assistant_id text NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_suites_tenant ON eval_suites (tenant_id, created_at);

CREATE TABLE eval_cases (
  id               text PRIMARY KEY,
  suite_id         text NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  tenant_id        text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question         text NOT NULL,
  expected_answer  text,
  must_include     jsonb NOT NULL DEFAULT '[]',
  must_not_include jsonb NOT NULL DEFAULT '[]',
  expected_sources jsonb NOT NULL DEFAULT '[]',
  expected_outcome text CHECK (expected_outcome IN ('answer', 'refuse', 'handoff')),
  access           text[] NOT NULL DEFAULT '{}',
  tags             jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_cases_suite ON eval_cases (suite_id, created_at);

CREATE TABLE eval_runs (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  suite_id          text NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  assistant_id      text NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  assistant_version integer NOT NULL,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  judge             boolean NOT NULL DEFAULT true,
  total             integer NOT NULL DEFAULT 0,
  error             text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX eval_runs_suite ON eval_runs (suite_id, created_at DESC);

CREATE TABLE eval_results (
  run_id        text NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id       text NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  question      text NOT NULL,
  answer        text NOT NULL,
  citations     jsonb NOT NULL DEFAULT '[]',
  outcome       text NOT NULL,
  guardrail     text,
  passed        boolean NOT NULL,
  score         real NOT NULL,
  checks        jsonb NOT NULL DEFAULT '[]',
  latency_ms    integer NOT NULL DEFAULT 0,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, case_id)
);
