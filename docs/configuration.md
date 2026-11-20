# Configuration

All settings are environment variables (a `.env` file works with Docker Compose and `scripts/dev.sh`). Empty values count as unset.

## Core

| Variable | Default | |
|---|---|---|
| `SECRET_KEY` | (required) | At least 32 characters. Session tokens and the encryption key for stored secrets (widget identity secrets, action and MCP headers, webhook and SSO secrets) are derived from it. Back it up with the database. To change it, follow [key rotation](operations.md#rotating-secret_key). |
| `SECRET_KEY_PREVIOUS` | | Former `SECRET_KEY` values (space-separated) during a rotation: secrets they encrypted still decrypt and sessions they signed stay valid. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/embed_assistant` | Postgres 14+ with the `vector` extension available. |
| `DATABASE_POOL_MAX` | `10` | Connections per instance. |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Used in embed snippets and the OpenAPI document. |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | |
| `LOG_LEVEL` | `info` | JSON logs on stdout. |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs. Enable only behind your own proxy. |

## Models

| Variable | Default |
|---|---|
| `ANTHROPIC_API_KEY` | |
| `ANTHROPIC_MODEL` / `ANTHROPIC_FAST_MODEL` | `claude-opus-5-5` / `claude-haiku-5-5` |
| `ANTHROPIC_EFFORT` | `low` (fast, cheap answers; raise for harder domains) |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | `https://api.openai.com/v1`, `gpt-5-mini` |
| `OPENAI_VISION` | `true`: the model accepts images (set `false` for a text-only model behind `OPENAI_BASE_URL`) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `llama3.2` |
| `OLLAMA_VISION` | `false`: set `true` when `OLLAMA_MODEL` is a vision model (e.g. `llama3.2-vision`, `qwen2.5vl`) |
| `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL` | (optional, any OpenAI-compatible `/embeddings`) |
| `RERANK_BASE_URL`, `RERANK_API_KEY`, `RERANK_MODEL` | (optional, any `POST /rerank` endpoint in the Cohere shape: Cohere, Jina, vLLM, Infinity...) |
| `MODELS_CONFIG` | Path to a JSON file that replaces all of the above. |

Without `MODELS_CONFIG`, these aliases are generated from whatever is configured, in this order:

- `standard`: Anthropic main model, OpenAI, Ollama, offline extractive mode
- `fast`: Anthropic fast model, OpenAI, Ollama, extractive
- `private`: Ollama only (or extractive), for data that must stay on your servers

### models.json

```json
{
  "deployments": [
    { "id": "claude", "provider": "anthropic", "model": "claude-opus-5-5", "apiKey": "${ANTHROPIC_API_KEY}", "effort": "low" },
    { "id": "vllm", "provider": "openai-compatible", "model": "qwen3-vl", "baseUrl": "http://vllm:8000/v1", "requiresKey": false, "vision": true },
    { "id": "extractive", "provider": "builtin-extractive" }
  ],
  "aliases": { "standard": ["claude", "vllm", "extractive"] },
  "embeddings": { "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small", "apiKey": "${OPENAI_API_KEY}" },
  "rerank": { "baseUrl": "http://vllm-rerank:8000/v1", "model": "BAAI/bge-reranker-v2-m3" }
}
```

- Providers: `anthropic` (official SDK; `effort`, `baseUrl` optional), `openai-compatible` (`/chat/completions` streaming; `vision: true` when the model accepts images), `builtin-extractive` (no model, quotes sources).
- Images visitors attach (widget `features.attachments`) are offered only when the alias's first available deployment can see images. Claude models always can. If a failover lands on a text-only deployment, the images are replaced by a note so the model asks the visitor to describe them instead of guessing.
- A deployment without credentials is skipped. A failure *before the first token* moves to the next deployment; after text has streamed the run fails rather than mixing two answers.
- A reranker is optional. When set, the best 20 fused search results are reordered by it before the top ones go to the model (`{model, query, documents, top_n}` in, `{results: [{index, relevance_score}]}` out). If it fails or takes more than 3 seconds, the fused order is used. It helps most with many similar documents; measure it with an evaluation before and after.
- Prompt caching: with Claude, the instructions and the conversation so far are marked cacheable, so each new question mostly pays for its own sources. OpenAI-compatible servers that cache prompt prefixes benefit from the same stable order.
- Changing the embeddings model is safe: chunks remember their model and dimension, and a vector index per dimension is created automatically. Re-sync sources to re-embed.

## Limits

| Variable | Default | |
|---|---|---|
| `RATE_LIMIT_RUNS_PER_MINUTE` | `10` | Per visitor (session subject). |
| `RATE_LIMIT_RUNS_PER_HOUR_IP` | `600` | Per client IP (generous: offices and mobile carriers share IPs). |
| `RATE_LIMIT_SESSIONS_PER_HOUR_IP` | `300` | Per client IP. Anonymous sessions are reused across page loads. |
| `DEFAULT_DAILY_TOKEN_BUDGET` | `2000000` | Per widget per UTC day; `0` = unlimited. Override per widget or per tenant. |
| `SESSION_TTL_SECONDS` | `43200` | Anonymous sessions. User sessions last at most 1 hour. |

## Processes

| Variable | Default | |
|---|---|---|
| `RUN_WORKER` | `true` | Run background jobs (crawling, webhook delivery, evaluations) in this process. Safe on every instance; with several you can dedicate some to it. |
| `SERVE_WIDGET` / `WIDGET_DIST_DIR` | `true` | Serve `/widget/*`. Disable when you host the files on a CDN. |
| `SERVE_CONSOLE` | `true` | Serve `/admin/` and `/demo`. |
| `METRICS_TOKEN` | | Require a bearer token for `/metrics`. |
| `PLATFORM_ADMIN_TOKEN` | | At least 32 characters. Enables the [platform API](operations.md#tenants) to create, suspend and delete tenants. Unset: that API does not exist. |
| `INGEST_ALLOW_PRIVATE_NETWORKS` | `false` | Allow crawling private/loopback addresses (local development only). |
| `OUTBOUND_ALLOW_PRIVATE_NETWORKS` | `false` | Allow actions and webhooks to call private/loopback addresses (for APIs on your internal network; keep off on shared hosts). |

## Data

| Variable | Default | |
|---|---|---|
| `DEFAULT_RETENTION_DAYS` | `0` | Delete conversations older than this many days (checked hourly); `0` keeps them. Each tenant can override it in the console under *Settings*. |
| `CONSOLE_SESSION_HOURS` | `12` | How long a single sign-on console session lasts. See [access.md](access.md). |
| `AUDIT_RETENTION_DAYS` | `400` | Delete audit log entries older than this many days; `0` keeps them forever. |

## Tracing (OpenTelemetry)

Tracing is off until an OTLP endpoint is set. It uses the standard OpenTelemetry variables, so any backend works (Jaeger, Grafana Tempo, Honeycomb, Datadog, New Relic, Elastic, Langfuse, an OpenTelemetry Collector…).

| Variable | |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Turns tracing on, e.g. `http://otel-collector:4318`. OTLP over HTTP (protobuf). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers for hosted backends, e.g. `x-honeycomb-team=…`. |
| `OTEL_SERVICE_NAME` | Defaults to `embed-assistant`. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | e.g. `parentbased_traceidratio` and `0.1` to keep 10 %. |
| `OTEL_SDK_DISABLED=true` | Force tracing off. |

What you get:

- A server span per HTTP request (`GET /v1/admin/widgets/{id}`), continuing the caller's trace from an incoming `traceparent` header.
- `invoke_agent` per run, with child spans for `retrieval`, every model call (`chat <model>`, with the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/): provider, model, token usage, finish reason) and every tool call (`execute_tool <name>`).
- A span per background job (crawls, webhook deliveries).
- `traceparent` on every outgoing request: actions, webhooks, MCP servers, crawls and model APIs, so your own services and LLM gateways join the same trace.
- `trace_id` and `span_id` in every log line written inside a span.

Message contents, prompts and tool arguments are never recorded in spans.

## CLI

```bash
node dist/cli/migrate.js            # apply migrations (the server also does this on start)
node dist/cli/seed.js               # first-run setup with demo data
node dist/cli/seed.js --new-admin-key
node dist/cli/openapi.js > openapi.json
node dist/cli/rotateSecrets.js [--dry-run]   # re-encrypt stored secrets with SECRET_KEY
```
