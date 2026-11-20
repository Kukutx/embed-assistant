#!/usr/bin/env bash
# Daily database backup (run by cron from install.sh). Keeps 14 local copies and,
# when BACKUP_UPLOAD_URL is set in .env, also uploads each one with an HTTP PUT
# (for example an Oracle Object Storage pre-authenticated request URL ending in "/o/",
# or any S3-compatible presigned prefix). On Oracle Cloud the URL can instead come from
# the instance metadata key embed_assistant_backup_url (set by oracle-cloud/offsite-backup.sh).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
mkdir -p backups
name="embed-assistant-$(date -u +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U postgres --format=custom --no-owner embed_assistant > "backups/$name"
find backups -name 'embed-assistant-*.dump' -mtime +14 -delete
oci_url() {
  curl -fsS -m 2 -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/ 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print({**(d.get("metadata") or {}), **(d.get("extendedMetadata") or {})}.get("embed_assistant_backup_url", ""))' 2>/dev/null || true
}
url=${BACKUP_UPLOAD_URL:-$(oci_url)}
where=""
if [ -n "$url" ]; then
  curl -fsS --retry 3 -T "backups/$name" "${url}${name}" >/dev/null
  where=", uploaded"
fi
echo "backup ok: $name ($(du -h "backups/$name" | cut -f1)$where)"
