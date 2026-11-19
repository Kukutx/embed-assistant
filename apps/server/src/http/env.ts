import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { Sql } from "../db/pool.js";
import type { WidgetRow } from "../db/store.js";
import type { SessionClaims, SessionSigner } from "../auth/session.js";
import type { IngestDeps } from "../knowledge/ingest.js";
import type { RateLimiter } from "../lib/rateLimit.js";
import type { ModelRegistry } from "../models/registry.js";
import type { RunEventBus } from "../runs/events.js";
import type { RunExecutor } from "../runs/executor.js";

/** Everything a request handler may use. Built once in main.ts (or a test). */
export interface Services {
  cfg: Config;
  version: string;
  sql: Sql;
  log: Logger;
  models: ModelRegistry;
  bus: RunEventBus;
  executor: RunExecutor;
  limiter: RateLimiter;
  sessions: SessionSigner;
  /** Key for encrypting widget identity secrets at rest. */
  secretsKey: Buffer;
  ingest: IngestDeps;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    clientIp: string;
    session: SessionClaims;
    widget: WidgetRow;
    tenantId: string;
  };
}
