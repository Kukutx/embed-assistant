-- 1.0.9: assistant version history (every saved configuration), and
-- evaluation runs pinned to a saved version.
CREATE TABLE assistant_versions (
  assistant_id text NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  config       jsonb NOT NULL,
  created_by   text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, version)
);

-- The current configuration of existing assistants becomes their first recorded version.
INSERT INTO assistant_versions (assistant_id, tenant_id, version, config, created_at)
SELECT id, tenant_id, version,
  jsonb_build_object(
    'name', name, 'instructions', instructions, 'modelAlias', model_alias, 'greeting', greeting,
    'suggestions', suggestions, 'placeholder', placeholder, 'disclaimer', disclaimer,
    'sourceIds', to_jsonb(source_ids), 'groundedOnly', grounded_only, 'actionIds', to_jsonb(action_ids),
    'mcpServerIds', to_jsonb(mcp_server_ids), 'handoff', handoff, 'followUps', follow_ups,
    'queryRewrite', query_rewrite, 'agenticSearch', agentic_search, 'clientTools', client_tools,
    'redactPii', redact_pii, 'guardrails', guardrails),
  updated_at
FROM assistants;

ALTER TABLE eval_runs ADD COLUMN pinned_version boolean NOT NULL DEFAULT false;
