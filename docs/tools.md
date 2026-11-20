# Tools, handoff and webhooks

An assistant can do more than answer from documents. It can call your HTTP endpoints, run functions in the visitor's page, hand the conversation to a person, and tell your systems what happened. Everything here is plain HTTP, JSON Schema and HMAC, so it works with any backend language.

## How a run uses tools

Each run is a short agent loop (at most 6 model steps). On every step the model may answer or call tools:

| Tool | Where it runs | Enabled by |
|---|---|---|
| `search_knowledge` | Server (hybrid search over the assistant's sources) | Assistant setting *agentic search* |
| HTTP actions | Your API, called by the server | Attaching actions to the assistant (`actionIds`) |
| Page tools | The visitor's browser | `EmbedAssistant.registerTool(...)` and the assistant setting *page tools* |
| `handoff_to_human` | Server (records the request, sends the webhook) | Assistant setting *handoff* |
| `open_playbook` | Server (returns a playbook's steps) | Attaching playbooks to the assistant (`playbookIds`), see [Playbooks](#playbooks) |
| `remember`, `forget` | Server (the signed-in user's memory) | Assistant setting *memory*, see [identity.md](identity.md#long-term-memory) |
| Remote MCP tools (`<server>__<tool>`) | A remote MCP server | Attaching MCP servers to the assistant (`mcpServerIds`), see [mcp.md](mcp.md) |

Tool arguments are validated against the tool's JSON Schema before anything runs; invalid calls go back to the model as errors. Tool calls appear in the event stream (`tool.started`, `tool.completed`) so any UI can show progress. Tool calling works with Claude and with any OpenAI-compatible model that supports function calling. The offline extractive mode never calls tools.

## Playbooks

A playbook is a procedure written in plain language: how to handle a refund,
reset a password, troubleshoot a device, qualify a sales lead. It has a
`name` (what the model uses, e.g. `refund_request`), a `description` (when to
use it) and the steps (`instructions`, Markdown, up to 20,000 characters).

```bash
curl -X POST $BASE/v1/admin/playbooks -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "name": "refund_request", "title": "Refunds",
  "description": "When a customer asks for their money back for an order.",
  "instructions": "1. Ask for the order number if you do not have it.\n2. Look it up with get_order_status.\n3. Delivered more than 30 days ago: explain the policy and offer store credit.\n4. Otherwise call create_refund and confirm the amount.\n5. Upset customer or more than 500 EUR: hand off to a person."
}'
curl -X PATCH $BASE/v1/admin/assistants/ast_... -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"playbookIds": ["pbk_..."]}'
```

Only the names and descriptions of an assistant's playbooks are in its
system prompt. When a request matches one, the model calls `open_playbook`
and gets the steps, then follows them: asking for missing details, calling
the actions they name, handing off when they say so. So an assistant can
carry dozens of playbooks without slowing down every answer, and the steps
can be long. Playbooks are written by the site owner and take precedence
over the model's habits, but never over the safety rules; they cannot enable
a tool the assistant does not have.

Playbooks are versioned with the assistant (`playbookIds`), run in
evaluations (cases can test that a procedure is followed, including over
several turns, see [quality.md](quality.md)), and show up in the answer
inspector as `open_playbook` calls. Disabled playbooks are not offered;
deleting one detaches it from every assistant.

## HTTP actions

Create actions in the console (*Actions*) or with `POST /v1/admin/actions`:

```json
{
  "name": "get_order_status",
  "title": "Checking your order",
  "description": "Look up the shipping status of an order by its id.",
  "method": "GET",
  "url": "https://api.example.com/orders/{orderId}",
  "parameters": {
    "type": "object",
    "properties": { "orderId": { "type": "string", "description": "Order id, e.g. A-42" } },
    "required": ["orderId"]
  },
  "headers": { "Authorization": "Bearer …" },
  "confirm": false,
  "requireUser": true,
  "timeoutMs": 10000
}
```

- `{param}` placeholders in the URL are filled from the arguments (URL-encoded). Other arguments go in the query string for `GET`/`DELETE` and in a JSON body otherwise.
- `headers` are encrypted at rest and never returned by the API (only their names).
- `confirm: true` makes the widget ask the visitor before the call ("Allow" / "Deny"). Use it for anything that changes data.
- `requireUser: true` hides the action from anonymous visitors and forwards the signed-in user to your API.
- Responses are given to the model as text (JSON is compacted, at most 16 KB). HTTP status ≥ 400 is reported to the model as an error.
- Requests go through the same SSRF-safe client as the crawler: private and loopback addresses are blocked unless `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`, and non-`GET` requests never follow redirects.
- `POST /v1/admin/actions/{id}/test` calls the action with sample arguments, so you can check it before attaching it.

### Verifying requests

Every action request carries:

| Header | |
|---|---|
| `EA-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |
| `EA-Conversation-Id` | The conversation that triggered the call |
| `EA-User-Id`, `EA-User-Email`, `EA-User-Name` (URL-encoded), `EA-User-Groups` (comma-separated) | Only with `requireUser`, for signed-in users |

The HMAC key is the widget's **identity secret** (the one your backend already uses to sign user tokens). The signed string is:

```
<t>.<METHOD>.<full URL>.<EA-User-Id or empty>.<raw body or empty>
```

Reject requests whose `t` is more than 5 minutes old. Example in Node.js; any language with HMAC-SHA256 works the same way:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(req, rawBody, secret) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["ea-signature"] ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const url = `https://api.example.com${req.url}`; // the exact URL configured in the action
  const signed = `${m[1]}.${req.method}.${url}.${req.headers["ea-user-id"] ?? ""}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signed).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], "hex"));
}
```

## Page tools

Page tools run in the visitor's browser, with the page's own session and data. They are the generic way to let the assistant read the cart, open a screen, prefill a form or start a tour, without exposing a new API:

```js
EmbedAssistant.registerTool({
  name: "get_cart",
  description: "Items currently in the visitor's shopping cart.",
  parameters: { type: "object", properties: {} },
  handler: async () => window.store.cart.items(),
});

EmbedAssistant.registerTool({
  name: "open_page",
  description: "Navigate the app to one of its pages.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  handler: ({ path }) => { router.push(path); return "opened"; },
});
```

- The handler's return value (string or JSON) goes back to the model; a thrown error is reported as a tool error. Handlers have 60 seconds.
- Registration returns a function that unregisters the tool; `EmbedAssistant.unregisterTool(name)` works too.
- At most 20 page tools are sent with a run. Names must match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`.
- Page tools are declared by the page, so treat them like any client input: never expose something through a page tool that the visitor could not already do in your UI.

Custom UIs (not using the widget) can offer the same thing over HTTP: send `clientTools` with `POST /v1/conversations/{id}/runs`, wait for the `tool.input_required` event with `kind: "client"`, then `POST /v1/runs/{runId}/tool-results` with `{ callId, output, isError? }`. Confirmations use the same endpoint with `{ callId, approved: true | false }`. Unanswered requests time out after 2 minutes.

## Human handoff

Turn on *handoff* in an assistant to give visitors a "talk to a person" button in the header, and to let the model offer it when it cannot help (`handoff_to_human` tool). Settings: the message shown to the visitor, an optional URL (your contact form, ticket page or live-chat tool) and a button label.

A handoff:

1. marks the conversation (visible in the console and the API as `handoffRequestedAt`),
2. shows the message and link in the widget and fires the `handoff` event on the page:
   ```js
   EmbedAssistant.on("handoff", ({ conversationId, url }) => liveChat.open({ ref: conversationId }));
   ```
3. sends the `handoff.requested` webhook with the transcript and a short summary, so a help desk can open a ticket with full context.

Repeated requests within 10 minutes don't send another webhook. API: `POST /v1/conversations/{id}/handoff` with `{ reason? }`.

### Live takeover from the console (or your helpdesk)

Handed-off conversations wait in the console's **Inbox**. A person with the `agent` role (or higher) opens one and takes over, or simply replies, which takes over automatically:

- The conversation switches to `human` mode. The AI stops answering (an answer in progress is cancelled).
- The visitor sees "Maria joined the conversation" and the reply immediately; their messages go to the person.
- *Hand back to assistant* returns the conversation to the AI, which then sees what the person wrote. *Resolve* also removes it from the inbox; a new handoff request puts it back.

Everything goes through the API, so a helpdesk or chat tool can carry the conversation instead of the console, with an `admin` API key:

| Step | API |
|---|---|
| Find waiting conversations | `GET /v1/admin/conversations?handoff=waiting` (or the `handoff.requested` webhook) |
| Take over | `POST /v1/admin/conversations/{id}/assign` `{ displayName? }` |
| Reply | `POST /v1/admin/conversations/{id}/reply` `{ content, displayName? }` |
| Receive the visitor's messages | `message.received` webhook |
| Hand back or resolve | `POST /v1/admin/conversations/{id}/release` `{ resolve }` |

Widgets and custom UIs follow `GET /v1/conversations/{id}/events` (Server-Sent Events: `conversation.updated`, `message.created`) and, in `human` mode, send messages with `POST /v1/conversations/{id}/messages` instead of starting runs (`POST /runs` returns `409` with `details.mode = "human"`). Messages written by people carry `author: { type: "human", name }`.

## Webhooks

Webhooks follow the [Standard Webhooks](https://www.standardwebhooks.com/) specification, so existing verification libraries for most languages work unchanged.

| Event | Data |
|---|---|
| `conversation.created` | `{ conversation, subject }` |
| `message.completed` | `{ conversationId, widgetId, assistantId, runId, subject, question, answer, tools, sourceCount, deploymentId, usage, guardrail }` (`guardrail` is null unless a [guardrail](quality.md) refused or replaced the answer) |
| `insights.digest` | `{ reportId, period: { from, to, days }, summary: { conversations, questions, resolutionRate, satisfaction, handoffs }, topics: [{ name, questions, problemRate, examples, suggestion }], url }`: the [weekly digest](quality.md#topics-and-the-weekly-digest) (tenants with `weeklyDigest`) |
| `guardrail.triggered` | `{ conversationId, widgetId, assistantId, runId, subject, rule, detail, question }`: a [guardrail](quality.md) refused a question (`term`, `topic`, `harmful`, `injection`) or replaced an answer (`answer_term`) |
| `feedback.submitted` | `{ conversationId, messageId, rating, comment }` |
| `handoff.requested` | `{ conversation, subject, trigger, reason, summary, pageContext, transcript, requestedAt }` |
| `message.received` | `{ conversationId, message, assignee, subject }`: the visitor wrote while a person handles the conversation |
| `source.synced` | `{ sourceId, status, pages?, failures?, error? }` |
| `audit.recorded` | An [audit log](api.md#audit-log) entry: `{ id, at, actor, action, target, changes, … }` |

Body: `{ "type": "<event>", "timestamp": "<ISO 8601>", "data": { … } }`. The payload is fixed when the event happens, so retries send identical bytes.

Headers: `webhook-id` (stable across retries; use it to deduplicate), `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64 HMAC-SHA256>`). The key is the base64 part of the `whsec_…` secret and the signed string is `<webhook-id>.<webhook-timestamp>.<body>`.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(headers, rawBody, secret /* "whsec_…" */) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signed = `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signed).digest();
  return headers["webhook-signature"].split(" ").some((s) => {
    const sig = Buffer.from(s.replace(/^v1,/, ""), "base64");
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}
```

Delivery: any `2xx` within 15 seconds counts as received. Otherwise it is retried with exponential backoff (about 15 s up to 1 h, 9 attempts in total). Recent deliveries, with status and response code, are listed in the console and at `GET /v1/admin/webhooks/{id}/deliveries`. Secrets can be rotated, and `POST /v1/admin/webhooks/{id}/test` sends a signed test event right away.
