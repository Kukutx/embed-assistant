#!/usr/bin/env bash
# One-click local development: Postgres in Docker, server + widget from source with auto-reload.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pnpm >/dev/null || corepack enable 2>/dev/null || npm install -g pnpm@10
if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)
  sed -i.bak "s|^SECRET_KEY=.*|SECRET_KEY=${secret}|" .env && rm -f .env.bak
fi
set -a; . ./.env; set +a
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/embed_assistant}"
export INGEST_ALLOW_PRIVATE_NETWORKS="${INGEST_ALLOW_PRIVATE_NETWORKS:-true}"

if [ -z "${SKIP_DB:-}" ]; then
  docker compose up -d db
  until docker compose exec -T db pg_isready -U postgres -d embed_assistant >/dev/null 2>&1; do sleep 1; done
  docker compose port db 5432 >/dev/null 2>&1 || true
fi

pnpm install
pnpm -r build
pnpm seed
pnpm --filter @embed-assistant/server dev
