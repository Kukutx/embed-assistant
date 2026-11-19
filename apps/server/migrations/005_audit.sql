-- 1.0.4: append-only audit log of admin changes.
CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL,
  actor_id    text,
  actor_name  text,
  action      text NOT NULL,
  method      text NOT NULL,
  route       text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  status      integer NOT NULL,
  ip          text,
  user_agent  text,
  request_id  text,
  trace_id    text,
  changes     jsonb
);
-- ids are ULIDs, so (tenant_id, id DESC) is newest-first order and a stable cursor.
CREATE INDEX audit_log_tenant_id ON audit_log (tenant_id, id DESC);
CREATE INDEX audit_log_tenant_target ON audit_log (tenant_id, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX audit_log_at ON audit_log (at);
