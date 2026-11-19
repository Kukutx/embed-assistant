# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/); the `/v1` HTTP protocol is backward compatible across 1.x.

## 1.0.3

Knowledge from more places, and inline embedding.

- **File uploads** to manual sources: PDF (page-aware), Word .docx (headings kept), Markdown (front matter title), HTML, text. Console upload dialog and `POST /v1/admin/sources/{id}/files` (multipart, 20 MB per file). Re-uploading a file replaces it.
- **llms.txt** sources: a sitemap URL ending in `/llms.txt` is read as an [llms.txt](https://llmstxt.org) index.
- The crawler reads PDF and Markdown pages as well as HTML.
- **Scheduled re-sync** of crawled sources (`syncIntervalHours`).
- **Edit sources** (`PATCH /v1/admin/sources/{id}`): name, URL, max pages, schedule, and access tags, which re-tag every stored passage immediately.
- **Inline mode** for the widget: `data-target="#element"` renders the chat inside a page element (help-center pages, app sidebars), always open, without the floating button.

## 1.0.2

Model Context Protocol, both directions.

- **MCP server** at `POST /mcp`: `search_knowledge`, `ask` (grounded answer with citations from an assistant), `get_document`, `list_sources`. Stateless 2026-07-28 revision with header validation, plus `initialize` for 2025-03-26 to 2025-11-25 clients. API keys with the `mcp` scope; their access tags filter knowledge. Origin check and per-key limits.
- **Remote MCP servers as tools**: connect servers in the console or API, cache and refresh their tool lists, expose them as `<server>__<tool>` with argument validation, visitor confirmation (except read-only tools), tool allowlists and signed-in-only mode. The client prefers the stateless revision and falls back to sessions; JSON and SSE responses.
- Admin console: *MCP servers* page with connection status, refresh and tool tester; MCP servers in the assistant form.
- Docs: docs/mcp.md, ADR 0006.

## 1.0.1

Agent capabilities. All additions are backward compatible: new optional fields, new endpoints and new event types.

- **Tool calling** for Claude (official SDK, thinking blocks preserved between steps) and OpenAI-compatible models, through one provider-neutral transcript. Bounded agent loop, JSON Schema validation of every tool call.
- **HTTP actions**: endpoints the assistant can call, with URL templates, encrypted secret headers, HMAC-signed requests (`EA-Signature`), optional visitor confirmation, user-only actions that forward the signed-in user, SSRF protection and a test console.
- **Page tools**: `EmbedAssistant.registerTool()` lets the host page offer functions that run in the visitor's browser; `clientTools` + `POST /v1/runs/{id}/tool-results` for custom UIs.
- **Agentic search** (`search_knowledge` tool) and **query rewriting** so follow-up questions retrieve the right passages.
- **Follow-up suggestions** after answers (`message.suggestions` event).
- **Human handoff**: header button, model tool, conversation flag, summary, `handoff` widget event and webhook.
- **Webhooks** following Standard Webhooks: `conversation.created`, `message.completed`, `feedback.submitted`, `handoff.requested`, `source.synced`. Durable retries, delivery log, secret rotation, test sends.
- **Insights**: questions, answer rate from knowledge, knowledge gaps, unhelpful answers, handoffs, satisfaction, tool usage.
- **Privacy**: optional PII masking (e-mail, phone, card, IBAN) before storage, retention policy (`DEFAULT_RETENTION_DAYS` or per tenant), permanent deletion of conversations, per-visitor erasure, NDJSON export.
- **API keys** with scopes (`admin`, `mcp`), managed in the console.
- Admin console: Insights, Actions, Webhooks and Settings pages; actions, handoff and behaviour options on assistants.

## 1.0.0

First release.

- Embeddable widget: 5 KB loader, lazy chat UI in Shadow DOM, streaming answers with citations, conversation history, feedback, copy, stop, dark mode, mobile full-screen, keyboard and screen-reader support, UI in 8 languages, JavaScript API.
- Server: sessions (anonymous and host-signed users), conversations, runs with resumable SSE, idempotent requests, one active run per conversation, cancellation across instances.
- Knowledge: website and sitemap crawling (SSRF-safe), push API, multilingual hybrid search, access tags enforced in SQL.
- Models: Anthropic (official SDK), any OpenAI-compatible endpoint, offline extractive mode; aliases with failover.
- Admin API and console; usage summary; Prometheus metrics; OpenAPI document.
- Docker image, Compose file, one-click scripts, CI.
