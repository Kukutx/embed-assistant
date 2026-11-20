-- 1.0.13: question topics (grouped visitor questions with outcomes and suggested docs) and the weekly digest.
CREATE TABLE topic_reports (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assistant_id   text,
  days           integer NOT NULL,
  period_from    timestamptz NOT NULL,
  period_to      timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  trigger        text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  method         text,
  question_count integer NOT NULL DEFAULT 0,
  topics         jsonb NOT NULL DEFAULT '[]',
  summary        jsonb,
  error          text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX topic_reports_tenant ON topic_reports (tenant_id, created_at DESC);

ALTER TABLE tenants ADD COLUMN weekly_digest boolean NOT NULL DEFAULT false;
