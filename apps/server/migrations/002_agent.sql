-- 1.0.1: tools (HTTP actions, page tools), human handoff, webhooks, follow-ups,
-- scoped API keys, retention and insights.

ALTER TABLE assistants
  ADD COLUMN action_ids     text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN handoff        jsonb   NOT NULL DEFAULT '{"enabled": false, "message": "I''ve passed this conversation to our team. Someone will get back to you as soon as possible.", "url": null, "label": null}',
  ADD COLUMN follow_ups     boolean NOT NULL DEFAULT true,
  ADD COLUMN query_rewrite  boolean NOT NULL DEFAULT true,
  ADD COLUMN agentic_search boolean NOT NULL DEFAULT true,
  ADD COLUMN client_tools   boolean NOT NULL DEFAULT true,
  ADD COLUMN redact_pii     boolean NOT NULL DEFAULT false;

ALTER TABLE tenants ADD COLUMN retention_days integer;

ALTER TABLE conversations
  ADD COLUMN handoff_at     timestamptz,
  ADD COLUMN handoff_reason text;
CREATE INDEX conversations_retention ON conversations (tenant_id, updated_at);

ALTER TABLE messages
  ADD COLUMN suggestions jsonb NOT NULL DEFAULT '[]',
  -- [{ "name", "isError" }] for analytics and the admin transcript
  ADD COLUMN tool_calls  jsonb NOT NULL DEFAULT '[]';

ALTER TABLE runs
  ADD COLUMN retrieval_query text,
  ADD COLUMN source_count    integer;
CREATE INDEX runs_conversation ON runs (conversation_id, created_at);

ALTER TABLE admin_keys
  ADD COLUMN scopes text[] NOT NULL DEFAULT '{admin}',
  ADD COLUMN access text[] NOT NULL DEFAULT '{public}';

CREATE TABLE actions (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL,
  parameters   jsonb NOT NULL,
  method       text NOT NULL,
  url          text NOT NULL,
  -- AES-256-GCM encrypted JSON object of header name -> value
  headers      text,
  header_names text[] NOT NULL DEFAULT '{}',
  confirm      boolean NOT NULL DEFAULT false,
  require_user boolean NOT NULL DEFAULT false,
  timeout_ms   integer NOT NULL DEFAULT 10000,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Answers from the widget to tool.input_required events.
CREATE TABLE run_inputs (
  run_id     text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id    text NOT NULL,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, call_id)
);

CREATE TABLE webhooks (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url         text NOT NULL,
  description text NOT NULL DEFAULT '',
  events      text[] NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  -- AES-256-GCM encrypted signing secret (whsec_...)
  secret      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_tenant ON webhooks (tenant_id);

CREATE INDEX jobs_tenant_type ON jobs (tenant_id, type, created_at DESC);
