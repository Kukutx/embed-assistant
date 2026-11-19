# Security model

| Threat | Mitigation |
|---|---|
| Another site embeds your widget | Per-widget origin allowlist, checked on config, session and every chat request. Empty list = blocked. |
| Forged identity | User tokens are HS256 JWTs signed by your backend with a per-widget secret; lifetime capped at 1 h; algorithm pinned. Secrets are stored AES-256-GCM encrypted and can be rotated. |
| Reading someone else's chats | Conversations are scoped to tenant + widget + subject in every query. Anonymous ids are 128-bit random values. |
| Restricted knowledge leaking | Access tags are filtered in SQL before ranking; the model never receives passages the session cannot read. |
| Prompt injection via documents or page context | Retrieved text and page context go in delimited blocks, closing delimiters are stripped, and the system prompt marks them as untrusted data. The model has no tools, so injected text cannot trigger actions. |
| XSS through model output | The widget renders Markdown by building DOM nodes; it never assigns model text to `innerHTML`. Links are limited to http(s) and mailto and open with `noopener noreferrer`. |
| SSRF through crawling | URLs are resolved and every IP is checked against private, loopback, link-local and metadata ranges at connect time (DNS rebinding safe), redirects are re-validated, bodies are size and time limited. |
| Cost abuse | Rate limits per visitor and per IP, per-widget daily token budgets, input length limits, one active run per conversation. |
| Admin key theft | Keys are stored as SHA-256 hashes, shown once, sent only as bearer tokens; admin API has no CORS. The console keeps the key in tab storage only and ships with a strict CSP. |

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
