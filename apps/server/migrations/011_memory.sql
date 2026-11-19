-- 1.0.10: long-term memory for signed-in users (opt-in per assistant).
ALTER TABLE assistants ADD COLUMN memory boolean NOT NULL DEFAULT false;

CREATE TABLE memories (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- `user:<sub>` from the host's signed user token; never anonymous visitors.
  subject_id      text NOT NULL,
  content         text NOT NULL,
  -- Where it was learned (the conversation may since have been deleted).
  conversation_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Last answer that had it in context (refreshed at most daily); retention counts from here.
  last_used_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_subject ON memories (tenant_id, subject_id, updated_at DESC);
