#!/usr/bin/env bash
# Daily database backup (run by cron from install.sh). Keeps 14 local copies and,
# when BACKUP_UPLOAD_URL is set in .env, also uploads each one with an HTTP PUT
# (for example an Oracle Object Storage pre-authenticated request URL ending in "/o/",
# or any S3-compatible presigned prefix).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
mkdir -p backups
name="embed-assistant-$(date -u +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U postgres --format=custom --no-owner embed_assistant > "backups/$name"
find backups -name 'embed-assistant-*.dump' -mtime +14 -delete
if [ -n "${BACKUP_UPLOAD_URL:-}" ]; then
  curl -fsS --retry 3 -T "backups/$name" "${BACKUP_UPLOAD_URL}${name}" >/dev/null
fi
echo "backup ok: $name ($(du -h "backups/$name" | cut -f1))"
