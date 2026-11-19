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
| `run.completed` | `{ usage }` |
| `run.failed` | `{ code, message }` (message is safe to show) |
| `run.cancelled` | `{}` |

Reconnect with `Last-Event-ID: <seq>` (or `?after=<seq>`) to continue exactly where you left off. Events are stored, so any server instance can serve the stream. Clients must ignore unknown event types and fields.

Other endpoints: `GET /v1/conversations`, `GET/DELETE /v1/conversations/{id}`, `GET /v1/conversations/{id}/messages`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel`, `POST /v1/messages/{id}/feedback`.

Rules:

- One active run per conversation (`409 conflict` otherwise).
- Repeating an `idempotencyKey` returns the original run instead of asking twice.
- Errors: `{ "error": { "code", "message", "requestId", "details?" } }`. `429` responses carry `Retry-After`.

## Admin API

`Authorization: Bearer ea_admin_…` (create keys with `seed.js --new-admin-key`). Resources: `/v1/admin/assistants`, `/widgets` (+ `/rotate-secret`, `/snippet`), `/sources` (+ `/sync`, `/documents`), `/conversations`, `/models`, `/usage`. Admin endpoints have no CORS: call them from your backend or the bundled console.

## Compatibility

`/v1` never removes or retypes fields and never changes the meaning of an existing field. New optional fields and new event types may appear at any time.
