-- 1.0.8: tenant lifecycle for multi-tenant installations (platform API).
ALTER TABLE tenants
  ADD COLUMN status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ADD COLUMN external_id  text,
  ADD COLUMN metadata     jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX tenants_external_id ON tenants (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX tenants_created ON tenants (created_at, id);
