-- 1.0.12: knowledge searches without an answer (POST /v1/search), for Insights.
CREATE TABLE searches (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  widget_id    text NOT NULL,
  assistant_id text NOT NULL,
  query        text NOT NULL,
  result_count integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX searches_tenant ON searches (tenant_id, created_at DESC);
