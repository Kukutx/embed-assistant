-- 1.0.2: remote MCP servers as assistant tools.

CREATE TABLE mcp_servers (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  title            text NOT NULL,
  url              text NOT NULL,
  -- AES-256-GCM encrypted JSON object of header name -> value
  headers          text,
  header_names     text[] NOT NULL DEFAULT '{}',
  confirm          boolean NOT NULL DEFAULT true,
  require_user     boolean NOT NULL DEFAULT false,
  allowed_tools    text[],
  enabled          boolean NOT NULL DEFAULT true,
  -- tools advertised at the last refresh
  tools            jsonb NOT NULL DEFAULT '[]',
  protocol_version text,
  server_name      text,
  last_error       text,
  refreshed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE assistants ADD COLUMN mcp_server_ids text[] NOT NULL DEFAULT '{}';
