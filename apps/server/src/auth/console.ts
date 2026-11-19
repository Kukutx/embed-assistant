/** Console users, single sign-on configuration, login codes and console sessions. */
import type { ConsoleUser, Role, SsoConfig } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { decrypt, encrypt, sha256 } from "../lib/crypto.js";
import { newId, randomToken } from "../lib/ids.js";
import { iso, isoOrNull } from "../lib/time.js";

type Tx = Sql | import("postgres").TransactionSql<{}>;

export const CONSOLE_SESSION_PREFIX = "ea_cs_";

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  role: Role;
  disabled: boolean;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export const toConsoleUser = (r: UserRow): ConsoleUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: r.disabled,
  lastLoginAt: isoOrNull(r.last_login_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listUsers(sql: Tx, tenantId: string): Promise<UserRow[]> {
  return sql<UserRow[]>`SELECT * FROM console_users WHERE tenant_id = ${tenantId} ORDER BY lower(email)`;
}

export async function getUser(sql: Tx, tenantId: string, id: string): Promise<UserRow | null> {
  const [r] = await sql<UserRow[]>`SELECT * FROM console_users WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return r ?? null;
}

/** Returns null when the e-mail is already taken in this tenant. */
export async function createUser(sql: Tx, tenantId: string, u: { email: string; name: string | null; role: Role }): Promise<UserRow | null> {
  const [r] = await sql<UserRow[]>`
    INSERT INTO console_users (id, tenant_id, email, name, role) VALUES (${newId("usr")}, ${tenantId}, ${u.email}, ${u.name}, ${u.role})
    ON CONFLICT DO NOTHING RETURNING *`;
  return r ?? null;
}

export async function updateUser(sql: Tx, tenantId: string, id: string, p: { name?: string | null; role?: Role; disabled?: boolean }): Promise<UserRow | null> {
  const [r] = await sql<UserRow[]>`
    UPDATE console_users SET
      name = ${p.name !== undefined ? p.name : sql`name`},
      role = ${p.role ?? sql`role`},
      disabled = ${p.disabled ?? sql`disabled`},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING *`;
  // A disabled user or a role change takes effect now: end their sessions.
  if (r && (p.disabled || p.role)) await sql`DELETE FROM console_sessions WHERE user_id = ${id}`;
  return r ?? null;
}

export async function deleteUser(sql: Tx, tenantId: string, id: string): Promise<boolean> {
  return (await sql`DELETE FROM console_users WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`).length > 0;
}

// ------------------------------------------------------------------ SSO config

export interface SsoRow {
  tenant_id: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_enc: string | null;
  allowed_domains: string[];
  auto_provision_role: Role | null;
  updated_at: Date;
}

export const ssoRedirectUri = (publicBaseUrl: string) => `${publicBaseUrl.replace(/\/+$/, "")}/auth/oidc/callback`;

export const toSsoConfig = (r: SsoRow | null, publicBaseUrl: string): SsoConfig => ({
  enabled: r?.enabled ?? false,
  issuer: r?.issuer ?? "",
  clientId: r?.client_id ?? "",
  hasClientSecret: Boolean(r?.client_secret_enc),
  allowedDomains: r?.allowed_domains ?? [],
  autoProvisionRole: r?.auto_provision_role ?? null,
  redirectUri: ssoRedirectUri(publicBaseUrl),
  updatedAt: r ? iso(r.updated_at) : null,
});

export async function getSso(sql: Tx, tenantId: string): Promise<SsoRow | null> {
  const [r] = await sql<SsoRow[]>`SELECT * FROM sso_configs WHERE tenant_id = ${tenantId}`;
  return r ?? null;
}

export async function putSso(
  sql: Tx,
  key: Buffer,
  tenantId: string,
  c: { enabled: boolean; issuer: string; clientId: string; clientSecret?: string | undefined; allowedDomains: string[]; autoProvisionRole: Role | null },
): Promise<SsoRow> {
  const secret = c.clientSecret !== undefined ? encrypt(key, c.clientSecret) : null;
  const [r] = await sql<SsoRow[]>`
    INSERT INTO sso_configs (tenant_id, enabled, issuer, client_id, client_secret_enc, allowed_domains, auto_provision_role)
    VALUES (${tenantId}, ${c.enabled}, ${c.issuer}, ${c.clientId}, ${secret}, ${c.allowedDomains}, ${c.autoProvisionRole})
    ON CONFLICT (tenant_id) DO UPDATE SET
      enabled = EXCLUDED.enabled, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
      client_secret_enc = coalesce(EXCLUDED.client_secret_enc, sso_configs.client_secret_enc),
      allowed_domains = EXCLUDED.allowed_domains, auto_provision_role = EXCLUDED.auto_provision_role, updated_at = now()
    RETURNING *`;
  return r!;
}

export const ssoClientSecret = (key: Buffer, r: SsoRow): string | null => (r.client_secret_enc ? decrypt(key, r.client_secret_enc) : null);

/** Tenants with SSO switched on (used to start a sign-in without naming the tenant). */
export async function enabledSsoTenants(sql: Tx, limit = 2): Promise<string[]> {
  return (await sql<{ tenant_id: string }[]>`SELECT tenant_id FROM sso_configs WHERE enabled ORDER BY tenant_id LIMIT ${limit}`).map((r) => r.tenant_id);
}

// ------------------------------------------------------------------ sign-in

export type LoginResult = { ok: true; user: UserRow } | { ok: false; reason: string };

/**
 * Find (or provision) the console user for a verified identity:
 * 1. a user already linked to this issuer + subject;
 * 2. otherwise an invited user with the same verified e-mail, which gets linked;
 * 3. otherwise a new user, if the tenant auto-provisions and the domain is allowed.
 */
export async function resolveLogin(
  sql: Sql,
  sso: SsoRow,
  id: { issuer: string; subject: string; email: string | null; emailVerified: boolean; name: string | null },
): Promise<LoginResult> {
  const domain = id.email?.split("@")[1] ?? "";
  const domainOk = sso.allowed_domains.length === 0 || sso.allowed_domains.includes(domain);
  return sql.begin(async (tx) => {
    let [user] = await tx<UserRow[]>`
      SELECT * FROM console_users WHERE tenant_id = ${sso.tenant_id} AND oidc_issuer = ${id.issuer} AND oidc_subject = ${id.subject}`;
    if (!user) {
      if (!id.email || !id.emailVerified) return { ok: false, reason: "your identity provider did not share a verified e-mail address" } as const;
      if (!domainOk) return { ok: false, reason: `sign-in is not allowed for ${domain}` } as const;
      [user] = await tx<UserRow[]>`
        UPDATE console_users SET oidc_issuer = ${id.issuer}, oidc_subject = ${id.subject}, updated_at = now()
        WHERE tenant_id = ${sso.tenant_id} AND lower(email) = ${id.email} AND oidc_subject IS NULL RETURNING *`;
      if (!user && sso.auto_provision_role) {
        [user] = await tx<UserRow[]>`
          INSERT INTO console_users (id, tenant_id, email, name, role, oidc_issuer, oidc_subject)
          VALUES (${newId("usr")}, ${sso.tenant_id}, ${id.email}, ${id.name}, ${sso.auto_provision_role}, ${id.issuer}, ${id.subject})
          ON CONFLICT DO NOTHING RETURNING *`;
      }
      if (!user) return { ok: false, reason: "you have not been invited to this console; ask an administrator" } as const;
    } else if (!domainOk) {
      return { ok: false, reason: `sign-in is not allowed for ${domain}` } as const;
    }
    if (user.disabled) return { ok: false, reason: "your account is disabled" } as const;
    const [updated] = await tx<UserRow[]>`
      UPDATE console_users SET last_login_at = now(), name = coalesce(name, ${id.name}) WHERE id = ${user.id} RETURNING *`;
    return { ok: true, user: updated! } as const;
  });
}

/** One-time code (60 s) that the console exchanges for a session token. */
export async function createLoginCode(sql: Tx, userId: string): Promise<string> {
  const code = randomToken(32);
  await sql`DELETE FROM console_login_codes WHERE expires_at < now()`;
  await sql`INSERT INTO console_login_codes (code_hash, user_id, expires_at) VALUES (${sha256(code)}, ${userId}, now() + interval '60 seconds')`;
  return code;
}

export async function redeemLoginCode(
  sql: Sql,
  code: string,
  hours: number,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ token: string; expiresAt: Date; user: UserRow } | null> {
  return sql.begin(async (tx) => {
    const [c] = await tx<{ user_id: string }[]>`
      DELETE FROM console_login_codes WHERE code_hash = ${sha256(code)} AND expires_at > now() RETURNING user_id`;
    if (!c) return null;
    const [user] = await tx<UserRow[]>`SELECT * FROM console_users WHERE id = ${c.user_id} AND NOT disabled`;
    if (!user) return null;
    const token = CONSOLE_SESSION_PREFIX + randomToken(32);
    const [s] = await tx<{ expires_at: Date }[]>`
      INSERT INTO console_sessions (token_hash, user_id, expires_at, ip, user_agent)
      VALUES (${sha256(token)}, ${user.id}, now() + make_interval(hours => ${hours}), ${meta.ip}, ${meta.userAgent?.slice(0, 300) ?? null})
      RETURNING expires_at`;
    return { token, expiresAt: s!.expires_at, user };
  });
}

/** The active, enabled user behind a console session token. */
export async function findSessionUser(sql: Tx, token: string): Promise<UserRow | null> {
  const hash = sha256(token);
  const [r] = await sql<(UserRow & { last_seen_at: Date })[]>`
    SELECT u.*, s.last_seen_at FROM console_sessions s JOIN console_users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.expires_at > now() AND NOT u.disabled`;
  if (r && Date.now() - r.last_seen_at.getTime() > 60_000) {
    await sql`UPDATE console_sessions SET last_seen_at = now() WHERE token_hash = ${hash}`;
  }
  return r ?? null;
}

export async function endSession(sql: Tx, token: string): Promise<void> {
  await sql`DELETE FROM console_sessions WHERE token_hash = ${sha256(token)}`;
}

export async function purgeSessions(sql: Tx): Promise<void> {
  await sql`DELETE FROM console_sessions WHERE expires_at < now()`;
  await sql`DELETE FROM console_login_codes WHERE expires_at < now()`;
}
