# ADR 0006: MCP in both directions, stateless first, compatible with older revisions

Status: accepted (1.0.2)

## Context
MCP has become the common way for AI clients to reach tools and knowledge. Two revisions are in use: the stateless 2026-07-28 revision (no sessions, `server/discover`, per-request `_meta`, routing headers) and the earlier session-based revisions (`initialize`, `Mcp-Session-Id`) that many existing clients and servers still speak.

## Decision
- Serve `/mcp` statelessly: every request is authenticated with an API key and answered in one JSON response. Accept 2026-07-28 requests with strict header validation, and answer `initialize` from older clients without minting a session.
- The client tries `server/discover` first and falls back to the `initialize` handshake (keeping the session id if the server issues one and re-initializing when it expires). It accepts JSON and SSE responses and stops reading as soon as its response arrives.
- Remote tools are cached in Postgres and exposed through the same tool layer as HTTP actions (ADR 0005), with confirmation and allowlists.
- API keys with an `mcp` scope and access tags instead of OAuth for now.

## Consequences
Works with current and older MCP clients and servers without sticky sessions, so any instance can serve any request. Clients that require OAuth discovery cannot connect yet; adding RFC 9728 metadata and token validation later does not change the tool contracts.
