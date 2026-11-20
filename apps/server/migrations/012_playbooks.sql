-- 1.0.11: playbooks (plain-language procedures loaded on demand), answer style,
-- and multi-turn evaluation cases.
CREATE TABLE playbooks (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL,
  instructions text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE assistants
  ADD COLUMN playbook_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN style        jsonb  NOT NULL DEFAULT '{}';

ALTER TABLE eval_cases ADD COLUMN history jsonb NOT NULL DEFAULT '[]';
