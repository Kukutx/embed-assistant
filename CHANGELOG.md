# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/); the `/v1` HTTP protocol is backward compatible across 1.x.

## 1.0.12

Sees what visitors see, and measures what it resolves.

- **Screenshots and images**: visitors can attach up to 4 images to a question (paperclip, paste or drag and drop; `features.attachments` on the widget, off by default). Vision models read them with the question: Claude as image blocks, OpenAI-compatible servers as `image_url` parts (`vision: true` in models.json, `OPENAI_VISION`, `OLLAMA_VISION`). Offered only when the assistant's model can see images; a failover to a text-only deployment replaces them with a note. The widget downscales big images before upload. `POST /v1/conversations/{id}/attachments` (image bytes as the body, type detected from the bytes), `attachmentIds` on runs, `attachments` on user messages, downloads for the owner and admins, thumbnails in console transcripts and the inbox. See [docs/api.md](docs/api.md#images-screenshots) and [docs/security.md](docs/security.md).
- **Search without an answer**: `POST /v1/search` and `EmbedAssistant.search(query)` return the best passages for a query with the visitor's access rules and no model call, for your own search box or article suggestions. Admins test retrieval with `GET /v1/admin/assistants/{id}/search?q=&access=` or *Knowledge → Test search*.
- **Resolution rate** in Insights: the share of answered conversations the assistant resolved on its own (no handoff, no answer rated down, last answer found knowledge), with the counts behind it, plus **searches without results**. See [docs/quality.md](docs/quality.md#insights).
- `GET /v1/admin/models` reports which deployments can see images.
- The widget build fails if a bundle grows past its size budget (guards against pulling a library into the page by accident).

## 1.0.11

Procedures and style.

- **Playbooks**: procedures in plain language (refunds, password resets, troubleshooting) attached to assistants with `playbookIds`. The model sees only names and descriptions and reads the steps on demand with the built-in `open_playbook` tool, so many long playbooks cost little context. `/v1/admin/playbooks`, a *Playbooks* page in the console, versioned with the assistant, run in evaluations, visible in the answer inspector. See [docs/tools.md](docs/tools.md#playbooks).
- **Answer style** per assistant: `style.tone` (neutral, friendly, formal) and `style.length` (short, medium, detailed).
- **Multi-turn evaluation cases**: `history` gives earlier turns, to test follow-up questions and steps in the middle of a procedure. The console takes `User:` / `Assistant:` lines.
- Built-in tool names (`open_playbook`, `remember`, `forget`) are reserved for actions.
- Version history no longer lists fields added by a later release as changes.
- Console: the tool and playbook name fields work in browsers that compile input patterns with the `v` flag.

## 1.0.10

Personal and hands-free.

- **Long-term memory** for signed-in users, opt-in per assistant (`memory`): the model keeps short facts users share across conversations with built-in `remember` and `forget` tools. Users see and erase them in the widget (*What I remember*, in all eight UI languages) or through `GET`/`DELETE /v1/memories`; admins through `/v1/admin/subjects/{subjectId}/memories`. Never for anonymous visitors; masked by `redactPii`, capped at 50 facts per user, included in subject erasure (`deletedMemories`) and expired by the retention policy. See [docs/identity.md](docs/identity.md#long-term-memory).
- **Voice input** in the widget (`features.voice`, off by default): a microphone button dictates the question with the browser's speech recognition; nothing is sent until the visitor sends it.
- Session routes now refuse requests without a session even if the middleware were not mounted (defence in depth).
- Viewing a subject's data needs `conversations:read`; deleting it still needs `conversations:delete`.

## 1.0.9

Change with confidence.

- **Assistant version history**: every save is a numbered version with who saved it, an optional change note and the fields that changed. Compare any version with the live one, restore it (saved as a new version; deleted sources, actions and MCP servers are left out), and **evaluate any saved version** (`{"version": n}` on a run) to see whether a change helped. `GET /v1/admin/assistants/{id}/versions`, `GET .../versions/{n}`, `POST .../versions/{n}/restore` (audited as `assistants.restore-version`). Existing assistants start with their current configuration as the first recorded version.
- **Answer inspector**: *Details* on every answer in the console (transcripts and inbox) shows the passages given to the model, the search query, each tool call with its kind, duration and result, tokens, time to first word, the deployment that answered, the assistant version, guardrail or error, and the event timeline. `GET /v1/admin/conversations/{id}/runs`.
- Evaluation runs record `pinnedVersion`; the console's *Run* panel has a version picker.

## 1.0.8

Ready to operate at scale.

- **Helm chart** (`deploy/helm/embed-assistant`): hardened pods (non-root, read-only root filesystem, no capabilities), startup/liveness/readiness probes, graceful drain, PodDisruptionBudget, optional HPA, Ingress, NetworkPolicy, ServiceMonitor, models config as a ConfigMap, existing-Secret support and an optional separate worker Deployment. Linted and rendered in CI.
- **Zero-downtime `SECRET_KEY` rotation**: `SECRET_KEY_PREVIOUS` keeps stored secrets readable and sessions valid during the switch, and `rotateSecrets.js` re-encrypts every stored secret (with `--dry-run`).
- **Platform API** (`/v1/platform/tenants`, enabled by `PLATFORM_ADMIN_TOKEN`): create tenants with a first admin key, list them with 30-day usage, label them with your own ids and metadata, suspend (widgets, keys, console and MCP stop; data kept), reactivate, issue recovery keys, and delete (only after suspension). Platform actions appear in the tenant's audit log.
- **Operations guide** ([docs/operations.md](docs/operations.md)): deployment, scaling, backups and restore, upgrades, key rotation, tenants and alerting.
- Releases can be published from the Actions tab (*Release → Run workflow*): image `ghcr.io/kukutx/embed-assistant:<version>` and a GitHub release.

## 1.0.7

Safe and measurable answers.

- **Guardrails** per assistant: blocked terms (Unicode-aware, whole words or substrings for scripts without spaces), blocked topics in plain language, moderation of harmful requests (with a supportive message for self-harm), prompt-injection detection, and a streaming answer check that replaces answers containing a blocked term before it reaches the visitor. The classifier runs in parallel with retrieval and fails open. Refusals are recorded per run, counted in Insights and sent as the new `guardrail.triggered` webhook event; `message.completed` carries `guardrail`.
- **Evaluations**: suites of cases (required and forbidden phrases, expected citations, expected behaviour, reference answers scored by a model judge), run in the background job queue without side effects, with per-case results compared to the previous run to show regressions and fixes. Run a suite against another assistant to compare configurations. `/v1/admin/evals`, `/v1/admin/eval-runs`, an *Evaluations* page in the console (import, export, run, results), and *Add to evals* from Insights.
- The MCP `ask` tool now uses the same answer path as the widget: guardrails and agentic knowledge search apply there too.
- Metrics: `ea_guardrail_checks_total`, `ea_eval_cases_total`.
- Insights no longer count refused questions as knowledge gaps.

## 1.0.6

People can step in.

- **Inbox** in the console: handed-off conversations wait there; an agent takes over (or just replies), the AI stops, and replies reach the visitor in real time. Hand back to the assistant, which then knows what the person said, or resolve.
- Conversations have a `mode` (`assistant` or `human`) and an assignee. New: `GET /v1/conversations/{id}/events` (Server-Sent Events, resumable), `POST /v1/conversations/{id}/messages`, `GET /v1/admin/conversations/{id}`, `POST /v1/admin/conversations/{id}/assign|reply|release`, `?handoff=` and `?assignee=` filters, `message.received` webhook for helpdesk bridges. Messages written by people carry `author`.
- Widget: "Maria joined the conversation", replies with the person's name, messages routed to the person, back to the AI on hand-back, in all eight UI languages.
- Fix: run event streams could wait up to 2 seconds for an event that was written while the stream was between reads.

## 1.0.5

Team access.

- **Console users with roles**: owner, admin, editor, analyst and agent, enforced on every admin endpoint from one permission table (new endpoints are closed to read-only roles by default). `GET /v1/admin/me`, `/v1/admin/users`, OpenAPI `x-permission` on every admin operation.
- **Single sign-on with OpenID Connect** for any provider: authorization code flow with PKCE, nonce and state, ID token verification against the provider's keys, invitations linked by verified e-mail then by subject, optional auto-provisioning for allowed domains. Console *Team and sign-in* page; `CONSOLE_SESSION_HOURS`.
- Sign-ins, refused sign-ins and sign-outs in the audit log; audit entries name the person who made each change.
- The console shows only the pages a role may use.

## 1.0.4

Operability and compliance.

- **Audit log**: every successful admin change and every conversation export is recorded with the key that made it, action, target, IP, user agent, request id, trace id and the redacted request body. `GET /v1/admin/audit-log` with filters and cursor paging, an *Audit log* page in the console, the `audit.recorded` webhook event for SIEM streaming, and `AUDIT_RETENTION_DAYS` (default 400).
- **OpenTelemetry tracing** over OTLP, configured with the standard `OTEL_*` variables and off by default: HTTP server spans that continue incoming `traceparent`, agent, retrieval, model (GenAI semantic conventions, token usage) and tool spans, job spans, and `traceparent` on every outgoing request including model APIs. Message contents are never recorded.
- Log lines carry `trace_id` and `span_id`; widget `error` events carry the server `requestId`.

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
