# Architecture

```
┌──────────── host page (any site) ────────────┐
│ <script loader.js>  ── window.EmbedAssistant │
│   Shadow DOM: launcher ──lazy──> chat UI     │
└───────────────┬──────────────────────────────┘
                │ fetch + SSE, /v1 (versioned, OpenAPI)
┌───────────────▼──────────────────────────────┐
│ Node.js server (Hono)                        │
│  sessions · conversations · runs · admin     │
│  run executor ── retrieval ── model router   │
│  job worker (crawler)                        │
└───────────────┬──────────────────────────────┘
                │ SQL, LISTEN/NOTIFY
┌───────────────▼──────────────────────────────┐
│ Postgres + pgvector                          │
│  tenants, assistants, widgets, conversations │
│  messages, runs, run_events, knowledge,      │
│  chunks (tsvector + vector), jobs, limits    │
└──────────────────────────────────────────────┘
```

## A question, end to end

1. The widget posts the question. The server checks the session, origin, rate limits and daily budget, then, in one transaction guarded by a per-conversation advisory lock, stores the user message and a `queued` run.
2. The run executor (in the same process) retrieves passages: full-text search (language-neutral tokens; CJK as bigrams; word-form folding with prefix matching) and, when configured, vector search, fused with Reciprocal Rank Fusion. The access-tag filter is part of both SQL queries.
3. The prompt keeps the system instructions stable (cache-friendly) and puts sources and page context in delimited blocks marked as untrusted data.
4. The model router streams from the first available deployment of the assistant's alias. Text is flushed as `message.delta` events every 50 ms or 160 characters.
5. Every event is written to `run_events` and announced via an in-process emitter plus `pg_notify`. SSE handlers read rows after their last sequence number, so streams resume after disconnects and work across instances.
6. A heartbeat updates the run every 2 s and notices cancellation requested on another instance. Runs without a heartbeat for 30 s are marked failed by a reaper.

## Packages

- `packages/protocol`: zod schemas for every request, response and event. The server validates with them, the OpenAPI document is generated from them, and the widget imports their types only (zod never ships to browsers).
- `packages/widget`: `loader.js` (launcher, API queue, lazy load) and `assistant.<hash>.js` (UI). No framework.
- `apps/server`: HTTP layer (`src/http`), data access (`src/db/store.ts`, every function takes the tenant id), knowledge (`src/knowledge`), models (`src/models`), runs (`src/runs`).

## Multi-tenancy

Every row belongs to a tenant and every store function filters by tenant. Today a deployment usually has one tenant created by `seed`; the schema and admin keys are ready for hosting several.

## Scaling

The server is stateless apart from in-flight runs. Run several instances behind a load balancer; SSE streams can land on any instance. Postgres is the only shared component. Set `RUN_WORKER=false` on instances that should not crawl.
