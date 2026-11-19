# Security model

| Threat | Mitigation |
|---|---|
| Another site embeds your widget | Per-widget origin allowlist, checked on config, session and every chat request. Empty list = blocked. |
| Forged identity | User tokens are HS256 JWTs signed by your backend with a per-widget secret; lifetime capped at 1 h; algorithm pinned. Secrets are stored AES-256-GCM encrypted and can be rotated. |
| Reading someone else's chats | Conversations are scoped to tenant + widget + subject in every query. Anonymous ids are 128-bit random values. |
| Restricted knowledge leaking | Access tags are filtered in SQL before ranking; the model never receives passages the session cannot read. |
| Prompt injection via documents or page context | Retrieved text and page context go in delimited blocks, closing delimiters are stripped, and the system prompt marks them as untrusted data. Tools are opt-in per assistant, their arguments are validated against JSON Schema, actions that change data can require the visitor's confirmation, and user-only actions are hidden from anonymous visitors, so injected text cannot do more than the visitor could. |
| XSS through model output | The widget renders Markdown by building DOM nodes; it never assigns model text to `innerHTML`. Links are limited to http(s) and mailto and open with `noopener noreferrer`. |
| SSRF through crawling | URLs are resolved and every IP is checked against private, loopback, link-local and metadata ranges at connect time (DNS rebinding safe), redirects are re-validated, bodies are size and time limited. |
| Forged action calls or webhooks | Action requests carry an `EA-Signature` HMAC over time, method, URL, forwarded user id and body; webhooks are signed per [Standard Webhooks](https://www.standardwebhooks.com/). Secret action headers are encrypted at rest and never returned. |
| MCP access | `/mcp` needs an API key with the `mcp` (or `admin`) scope; its access tags filter knowledge in SQL like a visitor's groups; browser requests from other origins are rejected (DNS-rebinding protection); per-key rate limits. Remote MCP tools ask the visitor before each call unless marked read-only, can be limited to an allowlist, and their headers are encrypted. |
| SSRF through actions, MCP servers and webhooks | Same connect-time IP checks as crawling; non-GET requests never follow redirects. |
| Personal data in transcripts | Optional masking of e-mails, phone, card (Luhn) and IBAN (mod-97) numbers before storage; retention policy; permanent deletion by visitors and per-subject erasure by admins. |
| Cost abuse | Rate limits per visitor and per IP, per-widget daily token budgets, input length limits, one active run per conversation. |
| Undetected misuse of admin access | Append-only audit log of every admin change and export (actor, IP, request and trace id, redacted request body), viewable in the console, streamable to a SIEM via the `audit.recorded` webhook, and kept for `AUDIT_RETENTION_DAYS`. |
| Admin key theft | Keys are scoped (`admin` or `mcp`), stored as SHA-256 hashes, shown once, sent only as bearer tokens; admin API has no CORS. The console keeps the key in tab storage only and ships with a strict CSP. |

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
