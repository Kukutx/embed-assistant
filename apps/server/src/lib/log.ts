import { pino, type Logger } from "pino";
import { activeTraceIds } from "./telemetry.js";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "embed-assistant" },
    // Correlate logs with traces when tracing is on.
    mixin: () => activeTraceIds(),
    redact: {
      paths: ["req.headers.authorization", "*.token", "*.userToken", "*.apiKey", "*.identitySecret"],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
