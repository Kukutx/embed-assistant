import { pino, type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "embed-assistant" },
    redact: {
      paths: ["req.headers.authorization", "*.token", "*.userToken", "*.apiKey", "*.identitySecret"],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
