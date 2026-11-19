# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/); the `/v1` HTTP protocol is backward compatible across 1.x.

## 1.0.0

First release.

- Embeddable widget: 5 KB loader, lazy chat UI in Shadow DOM, streaming answers with citations, conversation history, feedback, copy, stop, dark mode, mobile full-screen, keyboard and screen-reader support, UI in 8 languages, JavaScript API.
- Server: sessions (anonymous and host-signed users), conversations, runs with resumable SSE, idempotent requests, one active run per conversation, cancellation across instances.
- Knowledge: website and sitemap crawling (SSRF-safe), push API, multilingual hybrid search, access tags enforced in SQL.
- Models: Anthropic (official SDK), any OpenAI-compatible endpoint, offline extractive mode; aliases with failover.
- Admin API and console; usage summary; Prometheus metrics; OpenAPI document.
- Docker image, Compose file, one-click scripts, CI.
