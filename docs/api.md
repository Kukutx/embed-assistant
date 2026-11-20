# HTTP API (v1)

The complete, machine-readable description is served at `GET /openapi.json`. This page explains the flow.

## Chat flow

1. `GET /v1/widgets/{widgetId}/config`: public settings (name, greeting, suggestions, theme). Cacheable.
2. `POST /v1/sessions` with `{ widgetId, anonymousId }` or `{ widgetId, userToken }` returns `{ token, expiresAt, subject }`. Send the token as `Authorization: Bearer …` below.
3. `POST /v1/conversations` returns a conversation.
4. `POST /v1/conversations/{id}/runs` with `{ content, context?, idempotencyKey? }` returns `202 { run, userMessage }`.
5. `GET /v1/runs/{runId}/events` streams Server-Sent Events until a terminal event.

```
id: 4
event: message.delta
data: {"seq":4,"runId":"run_…","type":"message.delta","ts":"…","data":{"messageId":"msg_…","text":"Hello"}}
```

| Event | Data |
|---|---|
| `run.started` | `{ modelAlias }` |
| `retrieval.completed` | `{ sources: Citation[] }` |
| `message.started` | `{ messageId }` |
| `message.delta` | `{ messageId, text }` |
| `message.completed` | `{ message }` (final text and the citations it actually uses) |
| `tool.started` | `{ callId, name, title }` |
| `tool.input_required` | `{ callId, name, title, kind: "client" \| "confirmation", input, timeoutMs }`: answer with `POST /v1/runs/{id}/tool-results` |
| `tool.completed` | `{ callId, name, isError }` |
| `handoff.requested` | `{ message, url }` |
| `message.suggestions` | `{ messageId, suggestions }` (follow-up questions) |
| `run.completed` | `{ usage }` |
| `run.failed` | `{ code, message }` (message is safe to show) |
| `run.cancelled` | `{}` |

Reconnect with `Last-Event-ID: <seq>` (or `?after=<seq>`) to continue exactly where you left off. Events are stored, so any server instance can serve the stream. Clients must ignore unknown event types and fields.

When a person on the team takes over (see [tools.md](tools.md#live-takeover-from-the-console-or-your-helpdesk)), the conversation's `mode` becomes `human`: follow `GET /v1/conversations/{id}/events` (Server-Sent Events `conversation.updated` and `message.created`, resumable with `Last-Event-ID`) and send with `POST /v1/conversations/{id}/messages`.

Other endpoints: `GET /v1/conversations`, `GET/DELETE /v1/conversations/{id}`, `GET /v1/conversations/{id}/messages`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel`, `POST /v1/messages/{id}/feedback`, `POST /v1/runs/{id}/tool-results`, `POST /v1/conversations/{id}/handoff`, and for signed-in users `GET /v1/memories`, `DELETE /v1/memories/{id}` and `DELETE /v1/memories` (what the assistant remembers, see [identity.md](identity.md#long-term-memory)). `DELETE /v1/conversations/{id}` deletes permanently. Tools and handoff are described in [tools.md](tools.md).

Rules:

- One active run per conversation (`409 conflict` otherwise).
- Repeating an `idempotencyKey` returns the original run instead of asking twice.
- Errors: `{ "error": { "code", "message", "requestId", "details?" } }`. `429` responses carry `Retry-After`.
- Every response carries `x-request-id` (send your own, up to 64 characters of `[A-Za-z0-9_.-]`, to correlate with your logs). Requests may carry a W3C `traceparent`; with tracing on, the server continues that trace.

## Admin API

`Authorization: Bearer ea_admin_…` (create the first key with `seed.js --new-admin-key`, more in the console under *Settings*), or a console session token `ea_cs_…` from single sign-on, limited by the person's role ([access.md](access.md)). Resources:

| Path | |
|---|---|
| `/v1/admin/assistants`, `/widgets` (+ `/rotate-secret`, `/snippet`) | Configuration |
| `/v1/admin/assistants/{id}/versions` (+ `/{version}`, `/{version}/restore`) | Version history: every saved configuration, who saved it, the change note and which fields changed; restore saves an old configuration as a new version |
| `/v1/admin/sources` (+ `PATCH`, `/sync`, `/documents`, `/files` multipart upload) | Knowledge |
| `/v1/admin/actions` (+ `/test`) | HTTP tools |
| `/v1/admin/playbooks` | Procedures the assistant follows ([tools.md](tools.md#playbooks)) |
| `/v1/admin/mcp-servers` (+ `/refresh`, `/test`) | Remote MCP servers as tools ([mcp.md](mcp.md)) |
| `/v1/admin/webhooks` (+ `/test`, `/rotate-secret`, `/deliveries`) | Webhooks |
| `/v1/admin/conversations` (+ `?handoff=waiting\|active\|resolved`, `DELETE`, `/export?days=` as NDJSON) | Transcripts and the handoff inbox |
| `/v1/admin/conversations/{id}/assign`, `/reply`, `/release` | Live takeover by a person |
| `/v1/admin/conversations/{id}/runs` | How each answer was produced: passages given to the model, tools and their timings, tokens, model deployment, assistant version, guardrail, errors and an event timeline |
| `/v1/admin/subjects/{subjectId}` (`DELETE`) | Erase everything about one visitor (conversations and memories) |
| `/v1/admin/subjects/{subjectId}/memories` (`GET`, `DELETE`) | What assistants remember about one signed-in user ([identity.md](identity.md#long-term-memory)) |
| `/v1/admin/insights?days=`, `/usage`, `/models` | Analytics |
| `/v1/admin/keys`, `/settings` | API keys, retention and budget |
| `/v1/admin/me`, `/users`, `/sso`, `/logout` | Caller and permissions, people and roles, single sign-on |
| `/v1/admin/audit-log` (`?action=&targetId=&actorId=&from=&to=&cursor=`) | Audit log of changes (read-only) |
| `/v1/admin/evals` (+ `/cases`, `/runs`), `/v1/admin/eval-runs/{id}` (+ `/cancel`) | Evaluation suites, runs and per-case results ([quality.md](quality.md)) |

### Audit log

Every successful change made through the admin API (create, update, delete, rotate, sync, upload, test calls, key creation and revocation, settings, erasure) and every conversation export is written to an append-only audit log: when, which key, the action (`widgets.update`), the target id, IP, user agent, request id, trace id, and the request body with secret values (headers, tokens, passwords, keys) redacted and long text shortened. Reads and failed requests are not recorded. There is no API to change or delete entries; they expire after `AUDIT_RETENTION_DAYS`. Subscribe a webhook to `audit.recorded` to stream entries to a SIEM.

## Platform API

For operators of a multi-tenant installation, enabled by `PLATFORM_ADMIN_TOKEN`: `/v1/platform/tenants` to create (with a first admin key), list with usage, rename, suspend, reactivate and delete tenants, and issue recovery keys. See [operations.md](operations.md#tenants).

Keys have a scope: `admin` keys (`ea_admin_…`) can use the whole admin API; `mcp` keys (`ea_mcp_…`) can only use the MCP endpoint `/mcp` ([mcp.md](mcp.md)) and get `401` here. Admin endpoints have no CORS: call them from your backend or the bundled console.

## Compatibility

`/v1` never removes or retypes fields and never changes the meaning of an existing field. New optional fields and new event types may appear at any time.
