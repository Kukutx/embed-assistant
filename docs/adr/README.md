# Architecture decision records

| # | Decision |
|---|---|
| [0001](0001-postgres-only.md) | Postgres is the only infrastructure dependency |
| [0002](0002-plain-sql.md) | Hand-written SQL with postgres.js instead of an ORM |
| [0003](0003-model-aliases.md) | Model aliases with ordered failover, official SDKs where they exist |
| [0004](0004-widget-without-framework.md) | Widget in plain TypeScript, Shadow DOM, lazy loaded |
| [0005](0005-provider-neutral-tools.md) | Provider-neutral tool calling; integrations through HTTP, page tools and Standard Webhooks |
| [0006](0006-mcp-dual-era.md) | MCP in both directions, stateless first, compatible with older revisions |
