-- 1.0.5: console users with roles, OpenID Connect single sign-on, console sessions.
CREATE TABLE console_users (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'analyst', 'agent')),
  disabled      boolean NOT NULL DEFAULT false,
  oidc_issuer   text,
  oidc_subject  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX console_users_email ON console_users (tenant_id, lower(email));
CREATE UNIQUE INDEX console_users_subject ON console_users (tenant_id, oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

CREATE TABLE sso_configs (
  tenant_id           text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT true,
  issuer              text NOT NULL,
  client_id           text NOT NULL,
  client_secret_enc   text,
  allowed_domains     text[] NOT NULL DEFAULT '{}',
  auto_provision_role text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One-time codes handed to the console after a successful sign-in (exchanged for a session token).
CREATE TABLE console_login_codes (
  code_hash  bytea PRIMARY KEY,
  user_id    text NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE console_sessions (
  token_hash   bytea PRIMARY KEY,
  user_id      text NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX console_sessions_user ON console_sessions (user_id);
CREATE INDEX console_sessions_expires ON console_sessions (expires_at);
