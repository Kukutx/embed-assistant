# ADR 0005: Provider-neutral tool calling; integrations through HTTP, page tools and Standard Webhooks

Status: accepted (1.0.1)

## Context
Help-center and in-product assistants are far more useful when they can look things up and act (order status, ticket creation, opening a screen) and when they can hand over to a person. The project must stay independent of any model vendor, backend language or host framework.

## Decision
- One internal transcript format (`user`, `assistant` with tool calls, `tool` results). Each provider adapter maps it to its native API: the Anthropic SDK's tool use (keeping thinking blocks intact between steps) and OpenAI-compatible function calling. The executor runs a bounded loop (6 steps, the last without tools).
- Tools are described with JSON Schema and arguments are validated on the server before execution.
- Three integration points, all language-agnostic: HTTP actions (signed with HMAC), page tools registered in the browser (results posted back over the public API), and outbound events as [Standard Webhooks](https://www.standardwebhooks.com/). No platform-specific plugins.
- Human input during a run (page-tool results, confirmations) is stored in Postgres, so any instance can receive it.

## Consequences
Any backend can expose capabilities with an HTTP endpoint and verify calls with a few lines of HMAC code; any front end can add capabilities with a function. Existing Standard Webhooks libraries verify our webhooks. Models without function calling still answer from retrieved knowledge. An MCP interface can be added on the same tool layer without changing these contracts.
