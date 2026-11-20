# Contributing

1. `npm install -g pnpm@10` (or `corepack enable` on Node.js 24 and older), then `pnpm install`
2. `./scripts/dev.sh` (or start Postgres yourself and run `pnpm -r build && pnpm seed && pnpm --filter @embed-assistant/server dev`)
3. `pnpm -r typecheck && pnpm test` (and `pnpm test:db` with a Postgres + pgvector database)

Guidelines:

- The wire protocol lives in `packages/protocol`. Changes to `/v1` must be additive (new optional fields, new event types).
- Every data-access function takes the tenant id. Never query tenant data without it.
- Keep the widget dependency-free and never assign untrusted text to `innerHTML`.
- New dependencies must be widely used and maintained; installs only accept versions older than 7 days (`minimumReleaseAge`).
- Commit messages: imperative mood, explain why.
