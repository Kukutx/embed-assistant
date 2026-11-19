import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { ingestSource, scheduleDueSyncs } from "./knowledge/ingest.js";
import { JobWorker } from "./knowledge/jobs.js";
import { metrics } from "./lib/metrics.js";
import { purgeExpired } from "./lib/retention.js";
import { purgeAudit } from "./lib/audit.js";
import { createServices, serverVersion } from "./services.js";
import { initTelemetry } from "./lib/telemetry.js";
import { deliverWebhook } from "./webhooks/webhooks.js";

const cfg = loadConfig();
// Tracing must be registered before anything creates spans.
const telemetry = await initTelemetry(serverVersion());
const s = createServices(cfg);
const { log, sql } = s;

const applied = await migrate(sql);
if (applied.length) log.info({ applied }, "migrations applied");
await s.bus.listen();

const worker = cfg.RUN_WORKER
  ? new JobWorker(sql, log, {
      ingest_source: (job) => ingestSource(s.ingest, job.tenant_id, String(job.payload.sourceId)),
      deliver_webhook: (job) =>
        deliverWebhook({ sql, key: s.secretsKey, log, allowPrivate: cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS }, job).then(
          () => metrics.webhooks.inc({ status: "ok" }),
          (err: unknown) => {
            metrics.webhooks.inc({ status: "error" });
            throw err;
          },
        ),
    })
  : null;
worker?.start();

const timers = [
  setInterval(() => void s.executor.reapStale().catch((err) => log.warn({ err }, "reaper failed")), 15_000),
  setInterval(() => void s.limiter.sweep().catch(() => {}), 3600_000),
  // Scheduled re-crawls (sources with syncIntervalHours).
  setInterval(() => void scheduleDueSyncs(sql).catch((err) => log.warn({ err }, "sync scheduler failed")), 5 * 60_000),
  setInterval(
    () =>
      void purgeExpired(sql, cfg.DEFAULT_RETENTION_DAYS)
        .then((n) => n && log.info({ deleted: n }, "retention: conversations deleted"))
        .catch((err) => log.warn({ err }, "retention purge failed")),
    3600_000,
  ),
  setInterval(() => void purgeAudit(sql, cfg.AUDIT_RETENTION_DAYS).catch((err) => log.warn({ err }, "audit purge failed")), 6 * 3600_000),
];

const app = createApp(s);
const server = serve({ fetch: app.fetch, hostname: cfg.HOST, port: cfg.PORT }, (info) => {
  const models = s.models.describe().map((m) => `${m.alias}=${m.deployments.filter((d) => d.available).map((d) => d.id).join(">")}`);
  log.info({ port: info.port, version: s.version, models }, `embed-assistant listening on ${cfg.PUBLIC_BASE_URL}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  timers.forEach(clearInterval);
  server.close();
  await Promise.allSettled([worker?.stop(), s.executor.shutdown(10_000)]);
  await sql.end({ timeout: 5 });
  await telemetry?.shutdown().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
