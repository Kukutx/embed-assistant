#!/usr/bin/env bash
# One-click self-host with Docker: creates .env (with a random SECRET_KEY), starts Postgres + server, seeds demo data.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(openssl rand -base64 48 2>/dev/null | tr -d '\n/+=' | cut -c1-48 || head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)
  sed -i.bak "s|^SECRET_KEY=.*|SECRET_KEY=${secret}|" .env && rm -f .env.bak
  echo "Created .env with a random SECRET_KEY. Add a model API key there any time (optional)."
fi

docker compose up -d --build
echo "Waiting for the server..."
for _ in $(seq 1 60); do
  if docker compose exec -T server node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 2
done
docker compose exec -T server node dist/cli/seed.js
