# Privacy and data protection

What embed-assistant stores, where personal data goes, how long it is kept and
how to answer requests from the people it is about. Written for the team that
runs it and for the privacy, security or procurement review of a customer.
Under the GDPR the organization that deploys embed-assistant is usually the
controller; the hosting and model providers it configures are its processors.
This page describes the software; it is not legal advice.

## What is stored

Everything lives in the one Postgres database (and its backups). Nothing is
written to local disk besides logs and backups.

| Data | Contents | Personal data |
| --- | --- | --- |
| Conversations and messages | Questions, answers, citations, tool calls, feedback and comments, handoff reason and summary, page context (URL, title, locale, attributes the site passes) | Whatever visitors type; the subject id (`anon:<random>` or `user:<your id>`) |
| Images | Images visitors attach (when a widget allows it) | Whatever the image shows |
| Long-term memory | Short facts about signed-in users (off by default) | Yes, by design; visible to and erasable by the user |
| Searches | Text of `POST /v1/search` queries and result counts, for Insights | Query text only; no subject id |
| Topic reports | Groups of similar questions with a few example questions | Example question text |
| Knowledge | Documents, passages and their vectors | Only what your sources contain |
| Console users and audit log | Name, e-mail, role, sign-ins; admin changes with IP, user agent and a redacted request body | Staff data |
| Rate-limit counters | Counters keyed by subject id or IP address | IP addresses, for at most 2 days |

**Masking.** With *Redact personal data* on (per assistant), e-mail addresses,
phone numbers, card numbers (Luhn-checked) and IBANs (mod-97) are replaced
before a question, feedback comment, search or memory is stored. It is pattern
based: a safety net, not a guarantee. Images are not masked.

**Encryption.** Secrets (provider keys, tool and webhook secrets) are encrypted
with AES-256-GCM; admin keys are stored as hashes. Conversation text is not
encrypted by the application: use encryption at rest of the disk or the
managed database. All traffic to the server is HTTPS (Caddy or your ingress).

## In the visitor's browser

The widget sets no cookies. It keeps, in `localStorage` under a key per
widget: a random anonymous id, the anonymous session token (short-lived) and
the id of the open conversation. Signed-in users' tokens come from your site
and are not stored. These items are needed for the service the visitor asks
for (keeping their conversation), which is why most sites list them as
strictly necessary rather than asking for consent; check with your own policy.

## Where data goes

Data leaves the server only to the services you configure.

| Recipient | What it receives | When |
| --- | --- | --- |
| Model providers (Anthropic, or any OpenAI-compatible API: OpenAI, Azure OpenAI, OpenRouter, a local model) | Assistant instructions, the conversation, retrieved passages, page context, attached images, tool results, memory facts | Every answer; questions to the fast model for guardrails and query rewriting when those are on; questions to group them into topics when Insights topics run |
| Embeddings provider (`EMBEDDINGS_*`) | Knowledge passages; visitor questions and searches | Indexing and each search. With `LOCAL_EMBEDDINGS=1` the model runs on the same server and nothing leaves it |
| Reranker (`RERANK_*`) | The question and candidate passages | Each search, when configured |
| Your HTTP actions and MCP servers | The arguments the model fills in for a tool call | When the assistant calls that tool |
| Your webhooks | Event payloads; `message.completed` and `handoff.requested` include the question, answer or transcript | On each event you subscribed to |
| OpenID Connect provider | Standard sign-in requests for console users | Console sign-in |
| OpenTelemetry collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) | Ids, model names, token counts and timings; no message text | When tracing is on |
| Off-site backup storage | Full database dumps | Daily, when configured |

Choose providers and regions to match your data residency needs; every model
setting accepts a base URL, so EU endpoints or self-hosted models work without
code changes. Most model APIs do not train on API traffic by default; confirm
the terms of the providers you use.

The list of processors for your deployment is these rows, filled in with the
providers you configured: hosting (for example the cloud running the server
and the database), each model provider, the embeddings and rerank providers if
they are separate, and the backup storage.

## How long it is kept

| Data | Kept |
| --- | --- |
| Conversations, messages, images, live events | The tenant's *retention days* (`PATCH /v1/admin/settings` `retentionDays`, or *Settings* in the console), else `DEFAULT_RETENTION_DAYS`; `0` keeps them. Counted from the last message |
| Long-term memory | The same period, counted from the fact's last use |
| Searches and topic reports | The same period |
| Images uploaded but never sent | 24 hours |
| Audit log | `AUDIT_RETENTION_DAYS` (default 400) |
| Rate-limit counters | 2 days |
| Finished background jobs | 30 days |
| Backups (single-server install) | 14 days on the server; 35 days in Oracle Object Storage with the off-site script (`KEEP_DAYS`) |

Expired data is deleted permanently by an hourly job, not hidden. Data deleted
from the database stays in backups until those expire.

## Requests from visitors and users

| Request | How |
| --- | --- |
| Access or portability (Art. 15, 20) | `GET /v1/admin/conversations/export?subjectId=user:123` returns every conversation of that subject as NDJSON; `GET /v1/admin/subjects/{subjectId}/memories` returns what assistants remember. Signed-in users can see their memory in the widget |
| Erasure (Art. 17) | `DELETE /v1/admin/subjects/{subjectId}` deletes all their conversations (with messages, images and events) and memories. Visitors can delete a conversation themselves in the widget, and users can erase their memory |
| Rectification (Art. 16) | Users correct a remembered fact by telling the assistant, or delete it; conversation history is a record and is not edited |
| Objection or restriction | Delete the subject's data, or stop sending their identity token so they chat anonymously |

For anonymous visitors the subject id is the random id in their browser
(`anon:…`), visible in the console's conversation view; ask them for a
conversation link or the time of the conversation to find it. Copies already
sent to webhooks, tools or your help desk are not reachable from here: erase
them there too. Every export and erasure is recorded in the audit log.

## Checklist before going live

- Pick retention days for each tenant; the default keeps conversations.
- Turn on *Redact personal data* for assistants where visitors may type such data.
- Mention the assistant, the model providers and the retention in your privacy notice, and label the assistant as AI (the widget's disclaimer text is configurable).
- List the processors above in your records and sign their data processing terms.
- Keep `OUTBOUND_ALLOW_PRIVATE_NETWORKS` off unless tools must reach internal hosts.
- Give console roles that only read what each person needs (see [access.md](access.md)), and review the audit log of exports and erasures.
- Turn on off-site backups with a lifecycle rule, and test a restore ([operations.md](operations.md#backups-and-restore)).

See also [security.md](security.md) for the threat model and controls.
