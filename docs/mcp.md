# MCP

embed-assistant speaks the [Model Context Protocol](https://modelcontextprotocol.io) in both directions:

- **As a server** at `/mcp`: IDE agents, desktop assistants and other AI systems can search and read your knowledge base, or get grounded answers, with the same access rules as the website widget.
- **As a client**: assistants can use the tools of remote MCP servers (ticketing, CRM, booking, internal systems) alongside HTTP actions and page tools.

Both use Streamable HTTP. The current protocol revision (2026-07-28, stateless) is preferred, and the earlier revisions 2025-03-26, 2025-06-18 and 2025-11-25 are supported for older clients and servers.

## The `/mcp` server

1. Create an API key with the **mcp** scope (console → *Settings* → *API keys*, or `POST /v1/admin/keys` with `{ "name": "ide", "scopes": ["mcp"], "access": ["public", "staff"] }`). The key's **access tags** decide what it can read, exactly like a signed-in visitor's groups.
2. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "embed-assistant": {
      "type": "http",
      "url": "https://assistant.example.com/mcp",
      "headers": { "Authorization": "Bearer ea_mcp_…" }
    }
  }
}
```

| Tool | |
|---|---|
| `search_knowledge` | Hybrid search. `{ query, limit?, sourceIds? }` → passages with title, URL and `documentId` (also as `structuredContent`). |
| `ask` | A grounded answer with numbered citations from one of your assistants (same instructions, sources and model). `{ question, assistantId? }` |
| `get_document` | Full text of a document. `{ documentId }` |
| `list_sources` | Knowledge sources the key can read. |

Protocol behaviour:

- `POST` only (`GET`/`DELETE` → `405`). JSON responses, no sessions are created.
- 2026-07-28 requests carry `_meta["io.modelcontextprotocol/protocolVersion"]` and must send matching `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name` headers; mismatches get `400` with error `-32020`, unknown versions `-32022` with the supported list, unknown methods `404`/`-32601`. Results include `resultType`, and `tools/list` includes `ttlMs`/`cacheScope`.
- Older clients call `initialize` first; the server answers with the newest older revision it shares with the client.
- Requests with an `Origin` header other than this server's own origin are rejected (`403`), which protects against DNS rebinding from browsers.
- Limits: 120 tool calls per minute and 500 `ask` calls per day per key. Calls are counted in `/metrics` as `ea_mcp_tool_calls_total`.

Authentication uses the API key as a bearer token. OAuth 2.1 with protected-resource metadata is not implemented yet; clients that only support OAuth can't connect.

## Remote MCP servers as tools

Console → *MCP servers* → *Connect MCP server*, or `POST /v1/admin/mcp-servers`:

```json
{
  "name": "helpdesk",
  "title": "Helpdesk",
  "url": "https://mcp.helpdesk.example/mcp",
  "headers": { "Authorization": "Bearer …" },
  "allowedTools": ["create_ticket", "get_ticket"],
  "confirm": true,
  "requireUser": true
}
```

Then tick the server in the assistant's settings (`mcpServerIds`).

- The tool list is fetched when you connect, refreshed every 6 hours in the background, and on demand (*Refresh*, `POST /v1/admin/mcp-servers/{id}/refresh`). Connection errors are shown on the server.
- The model sees each tool as `<name>__<tool>` (for example `helpdesk__create_ticket`), with the server's description and JSON Schema. Arguments are validated before the call.
- `confirm` (default on) asks the visitor before every call, **except** tools the server marks `readOnlyHint`. Only connect servers you trust: their descriptions and annotations are shown to the model.
- `allowedTools` limits which tools are exposed; `requireUser` hides the server from anonymous visitors.
- Headers are encrypted at rest and never returned. Requests use the SSRF-safe client (private addresses need `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`).
- Results are passed to the model as text (structured content as JSON, max 16 KB). Tools that ask for more input mid-call (elicitation, sampling) return an error to the model, because there is nobody on the server side of that loop.
- `POST /v1/admin/mcp-servers/{id}/test` calls a tool with sample arguments.
