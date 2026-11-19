# Console access: people, roles and single sign-on

Two kinds of callers use the admin API and console:

- **API keys** (`ea_admin_…`) for automation, CI and break-glass access. They hold every permission. Create them in *Settings*.
- **People**, who sign in to the console with your identity provider through OpenID Connect. Each person has one role.

## Roles

| Role | Can |
|---|---|
| `owner` | Everything, including adding, changing and removing other owners. |
| `admin` | Everything except managing owners. |
| `editor` | Maintain knowledge (sources, documents, uploads, syncs). Read configuration, conversations and insights. |
| `analyst` | Read configuration, conversations and insights; export conversations. |
| `agent` | Read conversations and answer handed-off chats. |

Permissions behind the roles: `config:read`, `config:write`, `knowledge:write`, `conversations:read`, `conversations:export`, `conversations:reply`, `conversations:delete`, `analytics:read`, `security:manage` (API keys, settings, people, single sign-on, audit log). Every admin endpoint lists the permission it needs in the OpenAPI document (`x-permission`). Endpoints added in future versions need `config:write` unless they say otherwise, so read-only roles never gain access by accident.

People cannot change or remove themselves, so nobody locks themselves out by mistake. Changing someone's role or disabling them ends their sessions immediately.

## Set up single sign-on

1. In your identity provider, create a **web application** (OpenID Connect, authorization code flow) with the redirect URI shown in the console under *Team and sign-in*: `https://<your server>/auth/oidc/callback`.
2. In the console, enter the **issuer URL**, **client id** and **client secret**, then save. The server checks the issuer's discovery document before saving.
3. Invite people by e-mail and pick their role. They choose *Sign in with single sign-on* on the console's sign-in page.

| Provider | Issuer URL |
|---|---|
| Microsoft Entra ID | `https://login.microsoftonline.com/<directory-id>/v2.0` (single-tenant app) |
| Google Workspace | `https://accounts.google.com` |
| Okta | `https://<org>.okta.com` (or a custom authorization server URL) |
| Auth0 | `https://<tenant>.<region>.auth0.com/` |
| Keycloak | `https://<host>/realms/<realm>` |
| Authentik, Zitadel, Ping, OneLogin, … | The provider's issuer URL |

Options:

- **Allowed e-mail domains**: only these domains may sign in.
- **Create accounts on first sign-in**: off by default (invited people only). When on, anyone from an allowed domain gets an account with the chosen role (never `owner`).

## How sign-in works

Authorization code flow with PKCE (S256), `state` and `nonce`. The ID token is verified against the provider's published keys (cached, refreshed when the provider rotates keys): signature (asymmetric algorithms only), issuer, audience, expiry and nonce. The first sign-in links the invitation by **verified** e-mail address; after that the person is recognised by issuer and subject, so a later e-mail change at the provider cannot take over another account. Requests to the provider use the same SSRF protection as crawling; for an identity provider on your internal network set `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`.

After the provider redirects back, the console receives a one-time code (valid for 60 seconds) and exchanges it for a session token (`ea_cs_…`) that it keeps in tab storage and sends as a bearer token, like an API key. The admin API never reads cookies, so it is not exposed to cross-site request forgery. Sessions last `CONSOLE_SESSION_HOURS` (default 12) and end on sign-out.

Sign-ins, refused sign-ins (with the reason) and sign-outs are written to the [audit log](api.md#audit-log), along with every change people make.

With several tenants on one server, the sign-in page asks for the organization id (the tenant id) when more than one tenant has single sign-on.
