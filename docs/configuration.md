# Configuration

All settings are environment variables (a `.env` file works with Docker Compose and `scripts/dev.sh`). Empty values count as unset.

## Core

| Variable | Default | |
|---|---|---|
| `SECRET_KEY` | (required) | At least 32 characters. Session tokens and the encryption key for widget secrets are derived from it. Changing it invalidates sessions and stored widget secrets. |
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
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `llama3.2` |
| `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL` | (optional, any OpenAI-compatible `/embeddings`) |
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
    { "id": "vllm", "provider": "openai-compatible", "model": "qwen3", "baseUrl": "http://vllm:8000/v1", "requiresKey": false },
    { "id": "extractive", "provider": "builtin-extractive" }
  ],
  "aliases": { "standard": ["claude", "vllm", "extractive"] },
  "embeddings": { "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small", "apiKey": "${OPENAI_API_KEY}" }
}
```

- Providers: `anthropic` (official SDK; `effort`, `baseUrl` optional), `openai-compatible` (`/chat/completions` streaming), `builtin-extractive` (no model, quotes sources).
- A deployment without credentials is skipped. A failure *before the first token* moves to the next deployment; after text has streamed the run fails rather than mixing two answers.
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
| `RUN_WORKER` | `true` | Run the crawler queue in this process. With several instances you can dedicate one to it. |
| `SERVE_WIDGET` / `WIDGET_DIST_DIR` | `true` | Serve `/widget/*`. Disable when you host the files on a CDN. |
| `SERVE_CONSOLE` | `true` | Serve `/admin/` and `/demo`. |
| `METRICS_TOKEN` | | Require a bearer token for `/metrics`. |
| `INGEST_ALLOW_PRIVATE_NETWORKS` | `false` | Allow crawling private/loopback addresses (local development only). |

## CLI

```bash
node dist/cli/migrate.js            # apply migrations (the server also does this on start)
node dist/cli/seed.js               # first-run setup with demo data
node dist/cli/seed.js --new-admin-key
node dist/cli/openapi.js > openapi.json
```
