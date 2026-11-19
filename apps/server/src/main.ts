import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { ingestSource } from "./knowledge/ingest.js";
import { JobWorker } from "./knowledge/jobs.js";
import { createServices } from "./services.js";

const cfg = loadConfig();
const s = createServices(cfg);
const { log, sql } = s;

const applied = await migrate(sql);
if (applied.length) log.info({ applied }, "migrations applied");
await s.bus.listen();

const worker = cfg.RUN_WORKER
  ? new JobWorker(sql, log, {
      ingest_source: (job) => ingestSource(s.ingest, job.tenant_id, String(job.payload.sourceId)),
    })
  : null;
worker?.start();

const timers = [
  setInterval(() => void s.executor.reapStale().catch((err) => log.warn({ err }, "reaper failed")), 15_000),
  setInterval(() => void s.limiter.sweep().catch(() => {}), 3600_000),
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
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
