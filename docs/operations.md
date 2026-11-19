# Operations

How to run embed-assistant in production: deployment, scaling, backups,
upgrades, key rotation and tenant management. The server is one stateless
Node.js process; all state is in Postgres.

## Deploying

**Docker Compose** (one host): see the README quick start. Put Postgres on a
volume you back up, and set `PUBLIC_BASE_URL` to the HTTPS URL behind your
reverse proxy (`TRUST_PROXY=true` there).

**Kubernetes**: the Helm chart in [`deploy/helm/embed-assistant`](../deploy/helm/embed-assistant)
runs the server with a hardened pod (non-root, read-only root filesystem, no
capabilities, no service account token), startup/liveness/readiness probes,
a rolling update that never drops below the desired replicas, a
PodDisruptionBudget, optional HPA, Ingress, NetworkPolicy, ServiceMonitor, a
models config as a ConfigMap and a separate worker Deployment if you want one.

```bash
kubectl create secret generic embed-assistant-env \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=DATABASE_URL='postgres://ea:...@postgres:5432/embed_assistant?sslmode=require' \
  --from-literal=ANTHROPIC_API_KEY='...'
helm install ea deploy/helm/embed-assistant \
  --set existingSecret=embed-assistant-env \
  --set publicBaseUrl=https://assistant.example.com \
  --set ingress.enabled=true --set ingress.hosts[0].host=assistant.example.com \
  --set 'ingress.hosts[0].paths[0].path=/' --set 'ingress.hosts[0].paths[0].pathType=Prefix'
```

The chart does not run Postgres. Use a managed Postgres 15+ with the
`pgvector` extension, or your Postgres operator.

Answers stream as Server-Sent Events. Proxies in front of the server must not
buffer responses and must allow long-lived requests (ingress-nginx:
`proxy-buffering: "off"`, `proxy-read-timeout: "3600"`).

## Scaling

- **Web**: add replicas. Instances coordinate through Postgres only (LISTEN/NOTIFY
  for live events, row locks for jobs, an advisory lock for migrations).
  An answer runs in the instance that received it; when an instance stops,
  answers in progress get `terminationGracePeriodSeconds` to finish, and the
  others mark answers of a lost instance as failed after 30 seconds.
- **Jobs** (crawling, webhook delivery, evaluations) run on every instance with
  `RUN_WORKER=true` and are claimed with `FOR UPDATE SKIP LOCKED`. Each kind
  has its own lane, so a long crawl never delays webhooks. Dedicate instances
  with `RUN_WORKER=false` on the web tier and `worker.separate=true` in Helm.
- **Database**: size the pool with `DATABASE_POOL_MAX` per instance; the sum
  over all instances must stay below the server's `max_connections` (or put
  PgBouncer in transaction mode in front). Each open chat stream holds no
  connection; it waits on a shared notification channel.
- **Models**: spread load and survive outages with several deployments per
  alias in `models.json` (automatic failover), and cap spend with token budgets.

## Backups and restore

What to keep:

| Item | Why |
| --- | --- |
| The Postgres database | Everything: configuration, knowledge, conversations, audit log. |
| `SECRET_KEY` (and any `SECRET_KEY_PREVIOUS`) | Stored secrets (widget identity secrets, action and MCP headers, webhook and SSO secrets) are encrypted with it. A restored database without its key loses those secrets. Keep it in your secret manager, separately from the database backups. |
| `models.json` and your environment | To recreate the deployment. |

**Recommended**: continuous archiving with point-in-time recovery (managed
Postgres backups, or `pgBackRest` / `WAL-G` for self-managed servers), plus a
daily logical dump kept elsewhere:

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > ea-$(date +%F).dump
```

**Restore** into an empty database with the same major Postgres version and
the `vector` extension available, then start the server with the same
`SECRET_KEY`:

```bash
createdb embed_assistant
pg_restore --no-owner --dbname "$DATABASE_URL" ea-2026-11-20.dump
```

Pending migrations are applied when the server starts. Practise a restore
regularly; a backup you have never restored is a hope, not a backup.

Knowledge from crawled sites can always be rebuilt with a sync, but uploaded
files and pushed documents exist only in the database.

## Upgrading

Within 1.x, upgrades are drop-in: the `/v1` API and the widget stay backward
compatible, and migrations only add (columns with defaults, new tables,
indexes). The usual procedure:

1. Read the [changelog](../CHANGELOG.md).
2. Back up (or check that point-in-time recovery is current).
3. Roll out the new image. The first instance to start applies migrations
   under an advisory lock; the others wait for it. Old instances keep serving
   during the rollout because the schema changes are additive.

Rolling back the image is safe after an additive migration; the database is
not rolled back.

## Rotating `SECRET_KEY`

Rotate when the key may have leaked, when someone who knew it leaves, or on a
schedule. No downtime, no lost sessions:

1. Deploy with the new key as `SECRET_KEY` and the old one in
   `SECRET_KEY_PREVIOUS`. New secrets use the new key; existing ones still
   decrypt; session tokens signed with the old key stay valid.
2. Re-encrypt everything stored:
   ```bash
   node dist/cli/rotateSecrets.js --dry-run   # what would change
   node dist/cli/rotateSecrets.js
   ```
   It reports, per table, how many values were re-encrypted, and exits with
   code 2 if a value cannot be decrypted with any configured key.
3. After the longest session lifetime (`SESSION_TTL_SECONDS`, 12 hours by
   default), remove `SECRET_KEY_PREVIOUS` and redeploy.

Single sign-on attempts in progress during the switch (a few minutes) may
need to be retried. Rotating `SECRET_KEY` does not change widget identity
secrets, admin keys or webhook signing secrets themselves; rotate those
individually in the console or API if they may have leaked.

## Tenants

One installation can serve many tenants (customers, business units or
environments), fully isolated in every query. With `PLATFORM_ADMIN_TOKEN` set,
operators manage them over the platform API:

| Call | |
| --- | --- |
| `POST /v1/platform/tenants` `{ name, externalId?, metadata?, adminKeyName? }` | Create a tenant; returns its first admin key once. |
| `GET /v1/platform/tenants?limit=&cursor=&status=&externalId=&q=` | List with 30-day usage (conversations, tokens). |
| `GET /v1/platform/tenants/{id}` | One tenant. |
| `PATCH /v1/platform/tenants/{id}` `{ name?, externalId?, metadata?, status? }` | Rename, relabel, `suspended` or `active`. |
| `POST /v1/platform/tenants/{id}/keys` `{ name }` | Recovery admin key for a tenant locked out of its console. |
| `DELETE /v1/platform/tenants/{id}` | Delete the tenant and all its data. Only after suspending it. |

A **suspended** tenant keeps its data, but its widgets disappear (within
5 seconds), and its admin keys, MCP keys, console sessions and single sign-on
stop working until it is reactivated. Scheduled crawls pause. Every platform
action is written to the tenant's own audit log as the actor
`platform operator`, so tenants can see what the operator did.

`externalId` holds your own customer or billing id (unique), and `metadata`
up to 30 string labels such as plan or region.

Keep the platform token out of tenant hands: it controls every tenant. Put
the platform API behind your internal network if you can (it lives under
`/v1/platform/`).

## Monitoring

`/healthz` (process alive) and `/readyz` (database reachable) for probes;
`/metrics` in Prometheus format (protect it with `METRICS_TOKEN`). Useful
alerts:

| Signal | Metric |
| --- | --- |
| Answers failing | `rate(ea_runs_total{status="failed"}[5m])` relative to all runs |
| Slow first token | `histogram_quantile(0.95, rate(ea_time_to_first_token_ms_bucket[5m]))` |
| Model provider trouble | `rate(ea_model_failovers_total[5m]) > 0` |
| Webhooks failing | `rate(ea_webhook_deliveries_total{status="error"}[15m])` |
| Guardrail classifier unavailable | `rate(ea_guardrail_checks_total{result="error"}[15m])` |
| Spend | `increase(ea_model_tokens_total[1d])` by deployment |

Traces go to any OpenTelemetry backend ([configuration.md](configuration.md#tracing-opentelemetry)),
and every log line is JSON with a request id that also appears in error
responses and in the widget's `error` event.
