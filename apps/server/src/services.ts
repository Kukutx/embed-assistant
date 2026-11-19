import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { SessionSigner } from "./auth/session.js";
import { createSql, type Sql } from "./db/pool.js";
import type { Services } from "./http/env.js";
import { deriveKey } from "./lib/crypto.js";
import { createLogger, type Logger } from "./lib/log.js";
import { metrics } from "./lib/metrics.js";
import { RateLimiter } from "./lib/rateLimit.js";
import { loadModelsFile, ModelRegistry } from "./models/registry.js";
import { RunEventBus } from "./runs/events.js";
import { RunExecutor } from "./runs/executor.js";

const here = dirname(fileURLToPath(import.meta.url));

export function serverVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** Wire every dependency from configuration. Tests pass their own sql/models. */
export function createServices(cfg: Config, overrides: { sql?: Sql; log?: Logger; models?: ModelRegistry } = {}): Services {
  const log = overrides.log ?? createLogger(cfg.LOG_LEVEL);
  const sql = overrides.sql ?? createSql(cfg.DATABASE_URL, cfg.DATABASE_POOL_MAX);
  const models =
    overrides.models ??
    new ModelRegistry(loadModelsFile(cfg), (from, err) => {
      metrics.failovers.inc({ from });
      log.warn({ deployment: from, err: err.message }, "model failover");
    });
  const bus = new RunEventBus(sql);
  return {
    cfg,
    version: serverVersion(),
    sql,
    log,
    models,
    bus,
    executor: new RunExecutor(sql, bus, models, log, {
      secretsKey: deriveKey(cfg.SECRET_KEY, "widget-secret-encryption"),
      allowPrivateNetworks: cfg.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
      version: serverVersion(),
    }),
    limiter: new RateLimiter(sql),
    sessions: new SessionSigner(deriveKey(cfg.SECRET_KEY, "session-token"), cfg.SESSION_TTL_SECONDS),
    secretsKey: deriveKey(cfg.SECRET_KEY, "widget-secret-encryption"),
    ingest: { sql, log, embeddings: models.embeddings, allowPrivate: cfg.INGEST_ALLOW_PRIVATE_NETWORKS },
  };
}
