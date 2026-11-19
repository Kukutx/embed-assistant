# embed-assistant

A self-hostable AI assistant you can add to **any** website or web app with one script tag: help center, product guide, onboarding helper, internal tool, or anything else you point it at.

It is built to be generic and boring to operate:

- **Any site, any stack.** One `<script>` tag (or `window.EmbedAssistantConfig`). The UI lives in a Shadow DOM, so it never clashes with your CSS or framework. No adapters to maintain.
- **Any model.** Claude via the official Anthropic SDK, any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, vLLM, LiteLLM, LM Studio, Ollama…), and a built-in offline mode that answers by quoting your docs. Assistants use *aliases* with automatic failover, so you can switch vendors without touching anything else.
- **Grounded answers with citations.** Crawl a website or sitemap, or push documents from any system over HTTP. Hybrid search (multilingual keyword search, plus vectors when you configure embeddings).
- **Knows who is asking, safely.** Your backend signs a short JWT; the assistant only searches knowledge that user may read. Filtering happens in SQL before the model sees anything.
- **One dependency.** Node.js and Postgres (with pgvector). No Redis, no queue service. Multi-instance safe.
- **Takes actions, not just answers.** Call your HTTP APIs as tools (signed requests, optional visitor confirmation), run functions in the visitor's page (`EmbedAssistant.registerTool`), and hand the conversation to a person with a summary. See [docs/tools.md](docs/tools.md).
- **Speaks MCP both ways.** Other AI tools (IDE agents, desktop assistants) can search your knowledge and get grounded answers through `/mcp`; assistants can use the tools of any remote MCP server. See [docs/mcp.md](docs/mcp.md).
- **Fits into your systems.** [Standard Webhooks](https://www.standardwebhooks.com/) for conversations, answers, feedback, handoffs, syncs and audit entries; scoped API keys; NDJSON export.
- **Learns where it falls short.** Insights show top questions, knowledge gaps, unhelpful answers, handoffs and tool usage, so you know which docs to write next.
- **Team access with single sign-on.** People sign in to the console through any OpenID Connect provider (Entra ID, Google, Okta, Auth0, Keycloak…) and get a role: owner, admin, editor, analyst or agent. See [docs/access.md](docs/access.md).
- **Ready for operations teams.** Audit log of every admin change (streamable to a SIEM), OpenTelemetry tracing with GenAI conventions to any OTLP backend, Prometheus metrics, request ids and structured JSON logs.
- **Privacy built in.** Optional masking of e-mails, phone, card and IBAN numbers before storage, retention policies, and per-visitor erasure.
- **Open protocol.** Versioned HTTP + Server-Sent Events API with an OpenAPI document. Build your own UI, bot or integration in any language.

> Status: 1.0. The `/v1` API only ever adds fields. See [CHANGELOG](CHANGELOG.md).

## Quick start (Docker, about 2 minutes)

```bash
git clone https://github.com/Kukutx/embed-assistant.git
cd embed-assistant
./scripts/quickstart.sh
```

The script creates `.env` with a random `SECRET_KEY`, starts Postgres and the server, and prints:

- an **admin key** for the console at `http://localhost:8787/admin/`
- a **demo page** at `http://localhost:8787/demo?widget=wgt_…`
- the **embed snippet** for your site

It works without any API key (offline quoting mode). Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or `OLLAMA_BASE_URL`) to `.env` and run `docker compose up -d` to get full AI answers.

## Embed it

```html
<script src="https://assistant.example.com/widget/loader.js" data-widget-id="wgt_…" async></script>
```

Add your site's origin (for example `https://www.example.com`) to the widget's *allowed websites* in the console. The loader is about 5 KB; the chat UI (about 20 KB gzipped) loads on first use.

| Attribute | Meaning |
|---|---|
| `data-widget-id` | Required. |
| `data-locale` | UI language (`en`, `zh`, `it`, `es`, `fr`, `de`, `ja`, `pt`). Defaults to the visitor's browser. Answers always follow the user's language. |
| `data-position` | `bottom-right` or `bottom-left`. |
| `data-accent-color` | Hex color, e.g. `#0f766e`. |
| `data-mode` | `light`, `dark` or `auto`. |
| `data-launcher="false"` | Hide the floating button and open the chat from your own UI. |
| `data-open` | Open on page load. |
| `data-page-context="false"` | Don't send the page URL and title with questions. |
| `data-target="#help"` | Inline mode: render the chat inside that element (sized by it, always open, no floating button), e.g. on a help-center page or in an app sidebar. |

JavaScript API, available as soon as the loader runs (calls are queued until the UI loads):

```js
EmbedAssistant.open();                       // also: close(), toggle()
EmbedAssistant.ask("How do I export my data?");
EmbedAssistant.setContext({ attributes: { plan: "pro", page: "billing" } });
EmbedAssistant.identify(async () => (await fetch("/api/assistant-token")).text());
EmbedAssistant.on("message", (m) => analytics.track("assistant_answer", m));
EmbedAssistant.on("handoff", ({ conversationId }) => openSupportChat(conversationId));

// Let the assistant use something only the page knows or can do.
EmbedAssistant.registerTool({
  name: "get_cart",
  description: "Items in the visitor's shopping cart.",
  handler: async () => store.cart.items(),
});
```

`EmbedAssistant.on("error", ({ code, message, requestId }) => …)` reports failures; `requestId` matches the server logs.

Single-page apps (React, Vue, Svelte, Angular…) can set `window.EmbedAssistantConfig = { widgetId: "wgt_…" }` and inject the script once. See [examples/](examples/).

## Signed-in users

Anonymous visitors only see knowledge tagged `public`. To recognise a user, your **backend** signs an HS256 JWT with the widget's identity secret:

```json
{ "sub": "user-123", "exp": 1767225600, "name": "Ada", "groups": ["staff"] }
```

`exp` must be at most one hour ahead. Users get the access tags `public`, `users` and every group in `groups`. Any language with a JWT library works; see [docs/identity.md](docs/identity.md) for Node.js, Python, Go, Java, C#, Ruby and Rust.

## Knowledge

- **Website, sitemap or [llms.txt](https://llmstxt.org)**: crawled in the background with an SSRF-safe fetcher (private networks are blocked), on demand or on a schedule (every 6 hours, daily, weekly…). HTML, Markdown, text and PDF pages are read; pages that disappear are removed.
- **Files**: upload PDF, Word (.docx), Markdown, HTML or text files in the console or with `POST /v1/admin/sources/{id}/files` (multipart). Uploading the same file name again replaces it.
- **Push**: `PUT /v1/admin/sources/{id}/documents` with `{ title, content, url?, externalId? }` from a CMS, ticketing system, docs build or script. Unchanged content is a no-op.
- **Access tags** on each source decide who can get answers from it. Changing them re-tags everything already stored.

## Tools and handoff

- **HTTP actions**: describe an endpoint once (method, URL template, JSON Schema for its arguments, secret headers) and attach it to assistants. Requests are signed with HMAC so your API can verify them; signed-in users are forwarded; risky actions ask the visitor first.
- **Page tools**: functions registered by the host page that run in the visitor's browser.
- **Agentic search**: the model can search the knowledge base again with better queries before answering.
- **Human handoff**: a "talk to a person" button and a model tool. Sends the transcript and a summary to your help desk via webhook and/or opens your own support URL.

- **MCP servers**: connect remote MCP servers and pick which tools an assistant may use.

Full guide with verification code: [docs/tools.md](docs/tools.md). MCP: [docs/mcp.md](docs/mcp.md).

## Models

With environment variables only, aliases are built for you (`standard`, `fast`, `private`), each ending with the offline mode. For full control, point `MODELS_CONFIG` at a JSON file like [config/models.example.json](config/models.example.json). Failover happens only before the first token, so an answer never mixes two models. Details: [docs/configuration.md](docs/configuration.md).

## API

- Public chat API: sessions, conversations, runs, SSE events with `Last-Event-ID` resume, cancel, feedback.
- MCP server: `POST /mcp` (knowledge search, grounded answers, documents).
- Admin API: assistants, widgets, knowledge, actions, MCP servers, webhooks, conversations (+ export, erasure), insights, usage, models, API keys, settings, audit log, people and single sign-on.
- Machine-readable: `GET /openapi.json`. Overview: [docs/api.md](docs/api.md).

## Architecture

```
host page ── loader.js (5 KB) ──lazy──> chat UI (Shadow DOM)
                │ HTTPS + SSE (/v1, versioned)
                ▼
          Node.js server (Hono)
   sessions · runs · retrieval · model router · crawler · admin
                │
                ▼
     Postgres + pgvector (data, search, rate limits, job queue, run events)
```

Every run writes its events to Postgres and announces them with `NOTIFY`, so any instance can serve any stream and clients resume without gaps. More in [docs/architecture.md](docs/architecture.md) and the decision records in [docs/adr/](docs/adr/).

## Development

Requirements: Node.js 22+, pnpm (via `corepack enable`), Docker (for Postgres).

```bash
./scripts/dev.sh          # Postgres in Docker, build, seed, server with auto-reload on :8787
pnpm test                 # unit tests
pnpm test:db              # + API tests against Postgres (TEST_DATABASE_URL)
pnpm openapi > openapi.json
```

Layout:

```
packages/protocol   wire schemas and types (zod), the single source of truth
packages/widget     loader + chat UI, plain TypeScript, built with esbuild
apps/server         API server, admin console (static/), migrations
```

## Security

Origin allowlist per widget, signed tool requests and webhooks, tool arguments validated against JSON Schema, confirmation for risky actions, optional PII masking, retention and erasure, short-lived session tokens, HS256 user tokens with a capped lifetime, secrets encrypted at rest (AES-256-GCM), admin keys stored as hashes, rate limits and daily token budgets, prompt-injection hardening for retrieved text, safe Markdown rendering (no `innerHTML` of model output), SSRF protection for crawling. See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

## Versioning

Semantic versioning, currently `1.0.x`. Within 1.x the `/v1` protocol is backward compatible.

## License

[Apache-2.0](LICENSE)
