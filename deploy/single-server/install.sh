#!/usr/bin/env bash
# Install embed-assistant on one Linux server (Ubuntu/Debian, or Oracle Linux/RHEL-like):
# Docker, Postgres, the server and Caddy with automatic HTTPS, a firewall opening for
# ports 80/443 and a daily database backup.
#
#   sudo DOMAIN=assistant.example.com KEYS_FILE=/path/keys.env ./install.sh
#
# DOMAIN      the address visitors and the console use; its DNS A record must point here.
#             Default: <public-ip>.sslip.io, a free name that works without a domain.
# KEYS_FILE   optional file with KEY=value lines (model API keys and other settings)
#             merged into .env. It is read, never printed.
# VERSION     image version (default: latest release).
# DIR         install directory (default: /opt/embed-assistant).
#
# Safe to run again: it keeps the existing .env, database and certificates.
set -euo pipefail

DIR=${DIR:-/opt/embed-assistant}
VERSION=${VERSION:-latest}
RAW=${RAW:-https://raw.githubusercontent.com/Kukutx/embed-assistant/main/deploy/single-server}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Installing Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq && apt-get install -y -qq ca-certificates curl cron >/dev/null
    curl -fsSL https://get.docker.com | sh
  elif command -v dnf >/dev/null; then
    dnf install -y -q dnf-plugins-core curl cronie
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    dnf install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable --now crond
  else
    echo "Unsupported system: install Docker with the compose plugin, then run this again."; exit 1
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true

say "Opening ports 80 and 443"
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
elif command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  # Oracle's Ubuntu images reject everything but SSH in iptables; allow web traffic before that rule.
  at=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null || iptables -I INPUT "$at" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
  done
  iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT "$at" -p udp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi
echo "Also allow TCP 80 and 443 in your cloud's network rules (on Oracle: the VCN security list)."

say "Preparing $DIR"
mkdir -p "$DIR" && cd "$DIR"
# docker-compose.yml and backup.sh are replaced on every run (settings live in .env);
# Caddyfile only when missing, since you may edit it (other sites go in sites/*.caddy).
for f in docker-compose.yml backup.sh Caddyfile; do
  [ "$f" = Caddyfile ] && [ -f "$f" ] && continue
  if [ -n "$HERE" ] && [ -f "$HERE/$f" ] && [ "$HERE" != "$DIR" ]; then cp "$HERE/$f" "$f.new"; else curl -fsSL "$RAW/$f" -o "$f.new"; fi
  mv "$f.new" "$f"
done
chmod +x backup.sh
mkdir -p sites

rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
setenv() { # setenv KEY VALUE: set only when the key is not in .env yet
  grep -q "^$1=" .env 2>/dev/null || printf '%s=%s\n' "$1" "$2" >> .env
}
touch .env && chmod 600 .env
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN=$(grep -s '^DOMAIN=' .env | cut -d= -f2- || true)
fi
if [ -z "${DOMAIN:-}" ]; then
  ip=$(curl -fsS --max-time 5 https://checkip.amazonaws.com | tr -d '[:space:]')
  DOMAIN="${ip//./-}.sslip.io"
fi
setenv DOMAIN "$DOMAIN"
setenv EMBED_ASSISTANT_VERSION "$VERSION"
setenv SECRET_KEY "$(rand 48)"
setenv POSTGRES_PASSWORD "$(rand 32)"
if [ -n "${KEYS_FILE:-}" ]; then
  [ -f "$KEYS_FILE" ] || { echo "KEYS_FILE not found: $KEYS_FILE"; exit 1; }
  # Only KEY=value lines; later values for the same key replace earlier ones.
  { tr -d '\r' < "$KEYS_FILE" | grep -E '^[A-Z][A-Z0-9_]*=' || true; } | while IFS= read -r line; do
    key=${line%%=*}
    grep -v "^$key=" .env > .env.tmp || true
    printf '%s\n' "$line" >> .env.tmp && mv .env.tmp .env
  done
  chmod 600 .env
fi
# An OpenRouter key works as the OpenAI-compatible provider: point it at OpenRouter.
if grep -q '^OPENAI_API_KEY=sk-or-' .env; then
  setenv OPENAI_BASE_URL https://openrouter.ai/api/v1
  setenv OPENAI_MODEL openai/gpt-5-mini
fi

say "Starting (https://$DOMAIN)"
docker compose pull -q
docker compose up -d
for _ in $(seq 1 60); do
  docker compose exec -T server node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 2
done

say "First-run setup"
if [ ! -f first-run.txt ]; then
  (umask 077 && docker compose exec -T server node dist/cli/seed.js > first-run.txt)
  cat first-run.txt
else
  echo "Already set up. The first admin key is in $DIR/first-run.txt (root only)."
fi

say "Daily backup at 03:30"
echo "30 3 * * * root $DIR/backup.sh >> /var/log/embed-assistant-backup.log 2>&1" > /etc/cron.d/embed-assistant-backup
chmod 644 /etc/cron.d/embed-assistant-backup

say "Done"
echo "Console: https://$DOMAIN/admin/   (first admin key: $DIR/first-run.txt, readable by root only)"
echo "HTTPS may take a minute on first start while the certificate is issued."
