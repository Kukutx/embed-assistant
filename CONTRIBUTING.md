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
- Admin console texts are English in `apps/server/static/admin/admin.js`, wrapped in `tx("…")` (`tx("{0} days", n)` for values). Add the translation of each new text to every file in `apps/server/static/admin/i18n/`; `console-i18n.test.ts` fails otherwise. A new language is a new `<lang>.json` plus its entry in `LANGS`.

## Releasing

1. Raise the version in every `package.json` (root, `apps/server`, `packages/protocol`, `packages/widget`) and in `deploy/helm/embed-assistant/Chart.yaml` (`version` and `appVersion`), and add a section to `CHANGELOG.md`.
2. Push to `main` and wait for CI.
3. Run the **Release** workflow by hand on `main` (Actions → Release → Run workflow), or push a tag `v<version>`. It publishes `ghcr.io/kukutx/embed-assistant:<version>` and `:latest` and creates the GitHub release.
4. Servers installed with `deploy/single-server/install.sh` and `EMBED_ASSISTANT_VERSION=latest` upgrade with `docker compose pull && docker compose up -d` in the install directory.

Within 1.x, `/v1` and the database stay backward compatible; migrations only add.
