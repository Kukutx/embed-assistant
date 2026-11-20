# Single server (Docker Compose + Caddy)

The cheapest production-shaped setup: one Linux VM (a free Oracle Cloud Arm instance, or any VPS with 1+ vCPU and 2+ GB RAM) running Postgres, the server and Caddy, which obtains and renews HTTPS certificates. The image is built for amd64 and arm64.

```bash
# On the server, as root (or with sudo):
curl -fsSL https://raw.githubusercontent.com/Kukutx/embed-assistant/main/deploy/single-server/install.sh -o install.sh
sudo DOMAIN=assistant.example.com KEYS_FILE=./keys.env bash install.sh
```

- `DOMAIN`: point its DNS A record at the server first. Without a domain, leave it out and the script uses `<public-ip>.sslip.io` (a free name that resolves to the IP), which also gets a certificate.
- `KEYS_FILE`: `KEY=value` lines merged into `.env`, for example `ANTHROPIC_API_KEY=…` and `OPENAI_API_KEY=…`. An OpenRouter key (`sk-or-…`) is pointed at OpenRouter automatically, as the failover provider.
- Open TCP 80 and 443 in the cloud's network rules (Oracle: the VCN security list). The script opens the VM's own firewall.

On Oracle Cloud, [`../oracle-cloud`](../oracle-cloud/) creates the VM, the network rules and runs this script for you from Cloud Shell.

The script prints the console URL and the first admin key (also saved in `/opt/embed-assistant/first-run.txt`, readable by root only). Running it again keeps the existing settings, data and certificates.

## Operations

| Task | Command (in `/opt/embed-assistant`) |
| --- | --- |
| Logs | `docker compose logs -f server` |
| Upgrade | set `EMBED_ASSISTANT_VERSION` in `.env`, then `docker compose pull && docker compose up -d` |
| Change settings | edit `.env`, then `docker compose up -d` |
| Serve another site | add `sites/<name>.caddy` (for example `www.example.com { reverse_proxy app:8080 }`), then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` |
| Update the deployment files | run `install.sh` again: it replaces `docker-compose.yml` and `backup.sh`, keeps `.env`, `Caddyfile`, `sites/`, data and certificates |
| Backup now | `./backup.sh` (daily at 03:30 by cron; 14 kept in `backups/`) |
| Semantic search without an API | run `install.sh` again with `LOCAL_EMBEDDINGS=1`: a multilingual embedding model (bge-m3, about 1.3 GB of memory) runs next to the server, then *Sync* each source once to embed it |
| Off-site backups | set `BACKUP_UPLOAD_URL` in `.env` to a write URL prefix, e.g. an Oracle Object Storage pre-authenticated request ending in `/o/` (on Oracle Cloud, [`offsite-backup.sh`](../oracle-cloud/README.md#off-site-backups) sets it up without copying anything) |
| Restore | `docker compose exec -T db pg_restore -U postgres -d embed_assistant --clean --if-exists < backups/<file>.dump` |

## Moving later

Nothing here is tied to the host. To move to a managed database (Supabase, Neon, RDS, Cloud SQL, Azure), restore a backup there with `pg_restore`, set `DATABASE_URL` in `.env` and run `docker compose up -d server`; to move the app, run the same image on any container platform or with the [Helm chart](../helm/embed-assistant). Keep `SECRET_KEY` with it: stored secrets are encrypted with it.
