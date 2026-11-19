-- embed-assistant schema, version 1.
-- Every tenant-owned row carries tenant_id and every query filters on it.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenants (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  daily_token_budget integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_keys (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     bytea NOT NULL UNIQUE,
  prefix       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE assistants (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  instructions  text NOT NULL DEFAULT '',
  model_alias   text NOT NULL DEFAULT 'standard',
  greeting      text NOT NULL,
  suggestions   jsonb NOT NULL DEFAULT '[]',
  placeholder   text,
  disclaimer    text,
  source_ids    text[] NOT NULL DEFAULT '{}',
  grounded_only boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistants_tenant ON assistants (tenant_id);

CREATE TABLE widgets (
  id                 text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assistant_id       text NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  allowed_origins    text[] NOT NULL DEFAULT '{}',
  theme              jsonb NOT NULL,
  default_locale     text,
  features           jsonb NOT NULL,
  daily_token_budget integer,
  -- AES-256-GCM encrypted with the server SECRET_KEY; see src/lib/crypto.ts
  identity_secret    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX widgets_tenant ON widgets (tenant_id);

CREATE TABLE conversations (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assistant_id text NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  widget_id    text NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  subject_id   text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('anonymous', 'user')),
  title        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX conversations_owner ON conversations (tenant_id, widget_id, subject_id, updated_at DESC);

CREATE TABLE messages (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  citations        jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL CHECK (status IN ('streaming', 'complete', 'failed', 'cancelled')),
  feedback         text CHECK (feedback IN ('up', 'down')),
  feedback_comment text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at, id);

CREATE TABLE runs (
  id                   text PRIMARY KEY,
  tenant_id            text NOT NULL,
  conversation_id      text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  widget_id            text NOT NULL,
  user_message_id      text NOT NULL,
  assistant_message_id text,
  status               text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  model_alias          text NOT NULL,
  assistant_version    integer NOT NULL,
  deployment_id        text,
  idempotency_key      text,
  error_code           text,
  error_message        text,
  input_tokens         integer,
  output_tokens        integer,
  first_token_ms       integer,
  context              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  heartbeat_at         timestamptz,
  UNIQUE (conversation_id, idempotency_key)
);
CREATE INDEX runs_tenant_created ON runs (tenant_id, created_at DESC);
CREATE INDEX runs_active ON runs (status, heartbeat_at) WHERE status IN ('queued', 'running');

CREATE TABLE run_events (
  run_id     text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE knowledge_sources (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('url', 'sitemap', 'manual')),
  url              text,
  access           text[] NOT NULL DEFAULT '{public}',
  max_pages        integer NOT NULL DEFAULT 200,
  status           text NOT NULL DEFAULT 'idle',
  last_error       text,
  last_ingested_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_sources_tenant ON knowledge_sources (tenant_id);

CREATE TABLE documents (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  source_id    text NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  title        text NOT NULL,
  url          text,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE TABLE chunks (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  source_id       text NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  document_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord             integer NOT NULL,
  heading         text,
  content         text NOT NULL,
  -- Tokenised text (CJK split into bigrams) so 'simple' full-text search works across languages.
  search_text     text NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  access          text[] NOT NULL,
  embedding       vector,
  embedding_model text,
  embedding_dim   integer
);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_scope ON chunks (tenant_id, source_id);
CREATE INDEX chunks_access ON chunks USING gin (access);

CREATE TABLE jobs (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts   integer NOT NULL DEFAULT 0,
  run_after  timestamptz NOT NULL DEFAULT now(),
  locked_at  timestamptz,
  locked_by  text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (status, run_after) WHERE status = 'queued';

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
