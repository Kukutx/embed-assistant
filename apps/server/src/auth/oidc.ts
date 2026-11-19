/**
 * OpenID Connect relying party for console sign-in: Authorization Code flow
 * with PKCE (S256), `state` and `nonce`, ID token verified against the
 * provider's JWKS. Works with any compliant provider (Microsoft Entra ID,
 * Google Workspace, Okta, Auth0, Keycloak, Authentik, Zitadel, Ping, ...).
 *
 * All requests to the provider go through safeFetch (SSRF protection; private
 * networks only when OUTBOUND_ALLOW_PRIVATE_NETWORKS is on, for in-house IdPs).
 */
import { createHash } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { safeFetch } from "../knowledge/safeFetch.js";
import { randomToken } from "../lib/ids.js";

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export class OidcError extends Error {}

const TTL_MS = 3600_000;
const discovery = new Map<string, { at: number; meta: ProviderMetadata }>();
const jwksCache = new Map<string, { at: number; set: ReturnType<typeof createLocalJWKSet>; kids: Set<string> }>();

const trimSlash = (s: string) => s.replace(/\/+$/, "");

async function getJson(url: string, allowPrivate: boolean, init?: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await safeFetch(url, { allowPrivate, accept: "application/json", timeoutMs: 10_000, maxBytes: 1024 * 1024, userAgent: "embed-assistant-sso/1.0", ...(init ?? {}) });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OidcError(`${new URL(url).host} returned ${res.status} without JSON`);
  }
  return { status: res.status, json };
}

/** Provider metadata from `/.well-known/openid-configuration`, cached for an hour. */
export async function discover(issuer: string, allowPrivate: boolean, fresh = false): Promise<ProviderMetadata> {
  const key = trimSlash(issuer);
  const hit = discovery.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit.meta;
  const { status, json } = await getJson(`${key}/.well-known/openid-configuration`, allowPrivate);
  if (status !== 200) throw new OidcError(`discovery failed (HTTP ${status})`);
  const meta = json as unknown as ProviderMetadata;
  for (const f of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof meta[f] !== "string" || !meta[f]) throw new OidcError(`discovery document has no ${f}`);
  }
  // The issuer in the document must be the one configured (OpenID Connect Discovery §4.3).
  if (trimSlash(meta.issuer) !== key) throw new OidcError(`issuer mismatch: configured ${issuer}, provider says ${meta.issuer}`);
  for (const f of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (!/^https?:\/\//i.test(meta[f])) throw new OidcError(`${f} must be an http(s) URL`);
  }
  discovery.set(key, { at: Date.now(), meta });
  return meta;
}

async function jwks(meta: ProviderMetadata, allowPrivate: boolean, kid: string | undefined) {
  const hit = jwksCache.get(meta.jwks_uri);
  // Refetch on an unknown key id: providers rotate keys.
  if (hit && Date.now() - hit.at < TTL_MS && (!kid || hit.kids.has(kid))) return hit.set;
  const { status, json } = await getJson(meta.jwks_uri, allowPrivate);
  if (status !== 200 || !Array.isArray(json.keys)) throw new OidcError(`JWKS fetch failed (HTTP ${status})`);
  const set = createLocalJWKSet(json as unknown as JSONWebKeySet);
  jwksCache.set(meta.jwks_uri, { at: Date.now(), set, kids: new Set((json.keys as { kid?: string }[]).map((k) => k.kid ?? "")) });
  return set;
}

/** Values the browser carries through the redirect (kept in a signed, HttpOnly cookie). */
export interface AuthRequest {
  state: string;
  nonce: string;
  verifier: string;
}

export function newAuthRequest(): AuthRequest {
  return { state: randomToken(24), nonce: randomToken(24), verifier: randomToken(48) };
}

export function authorizationUrl(meta: ProviderMetadata, o: { clientId: string; redirectUri: string; req: AuthRequest; loginHint?: string | undefined }): string {
  const u = new URL(meta.authorization_endpoint);
  const challenge = createHash("sha256").update(o.req.verifier).digest("base64url");
  const params: Record<string, string> = {
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: "openid email profile",
    state: o.req.state,
    nonce: o.req.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  claims: JWTPayload;
}

/** Exchange the authorization code and verify the ID token. */
export async function completeLogin(
  meta: ProviderMetadata,
  o: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; req: AuthRequest; allowPrivate: boolean },
): Promise<OidcIdentity> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.req.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const methods = meta.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (o.clientSecret && methods.includes("client_secret_basic")) {
    // RFC 6749 §2.3.1: form-encode both parts before base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(`${enc(o.clientId)}:${enc(o.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", o.clientId);
    if (o.clientSecret) form.set("client_secret", o.clientSecret);
  }
  const { status, json } = await getJson(meta.token_endpoint, o.allowPrivate, { method: "POST", headers, body: form.toString() });
  if (status !== 200) throw new OidcError(`token request failed: ${String(json.error ?? status)}${json.error_description ? ` (${String(json.error_description).slice(0, 200)})` : ""}`);
  const idToken = json.id_token;
  if (typeof idToken !== "string") throw new OidcError("the provider returned no ID token");

  const { kid, alg } = decodeProtectedHeader(idToken);
  if (!alg || alg === "none" || alg.startsWith("HS")) throw new OidcError(`unsupported ID token algorithm ${alg}`);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, await jwks(meta, o.allowPrivate, kid), {
      issuer: meta.issuer,
      audience: o.clientId,
      clockTolerance: 60,
      maxTokenAge: "1h",
    }));
  } catch (err) {
    throw new OidcError(`invalid ID token: ${(err as Error).message}`);
  }
  if (payload.nonce !== o.req.nonce) throw new OidcError("invalid ID token: nonce mismatch");
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== o.clientId) throw new OidcError("invalid ID token: azp mismatch");
  if (!payload.sub) throw new OidcError("invalid ID token: no subject");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
  // Microsoft Entra ID omits email_verified; it marks unverified domains with xms_edov=false
  // when that optional claim is enabled. Only an explicit "false" from either counts as unverified.
  const emailVerified =
    email !== null && payload.email_verified !== false && payload.email_verified !== "false" && payload.xms_edov !== false && payload.xms_edov !== "false";
  const name = typeof payload.name === "string" ? payload.name : null;
  return { issuer: meta.issuer, subject: payload.sub, email, emailVerified, name, claims: payload };
}

/** For tests. */
export function clearOidcCaches(): void {
  discovery.clear();
  jwksCache.clear();
}
