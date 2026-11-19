import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Public URL of this server, used in embed snippets and absolute links. */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/embed_assistant"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Root secret. Session tokens and stored widget secrets are derived from it. */
  SECRET_KEY: z.string().min(32, "SECRET_KEY must be at least 32 characters"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Trust X-Forwarded-For (only behind a reverse proxy you control). */
  TRUST_PROXY: bool.default(false),
  /** Path to a models JSON config. Defaults are derived from provider env vars. */
  MODELS_CONFIG: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_FAST_MODEL: z.string().default("claude-haiku-5-5"),
  /** Claude effort level for chat answers: low keeps latency down for support chat. */
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().default("llama3.2"),
  /** OpenAI-compatible embeddings endpoint (OpenAI, Ollama, vLLM...). Optional. */
  EMBEDDINGS_BASE_URL: z.string().url().optional(),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().optional(),
  /** Per-session and per-IP limits for creating runs. */
  RATE_LIMIT_RUNS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_RUNS_PER_HOUR_IP: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_SESSIONS_PER_HOUR_IP: z.coerce.number().int().min(1).default(300),
  /** Default daily model-token budget per widget (0 = unlimited). */
  DEFAULT_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(2_000_000),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(7 * 86400).default(12 * 3600),
  /** Allow ingestion from private/loopback addresses (development only). */
  INGEST_ALLOW_PRIVATE_NETWORKS: bool.default(false),
  /** Allow actions, webhooks and MCP servers on private/loopback addresses (self-hosted intranets). */
  OUTBOUND_ALLOW_PRIVATE_NETWORKS: bool.default(false),
  /** Default retention for conversations in days (0 = keep forever); tenants can override it. */
  DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  /** Keep audit log entries this many days (0 = forever). */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(400),
  /** Serve the bundled widget scripts from /widget (disable when using a CDN). */
  SERVE_WIDGET: bool.default(true),
  /** Directory holding the built widget files. */
  WIDGET_DIST_DIR: z.string().optional(),
  /** If set, GET /metrics requires `Authorization: Bearer <METRICS_TOKEN>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Serve the built-in admin console at /admin and the demo page at /demo. */
  SERVE_CONSOLE: bool.default(true),
  /** Run the background job worker in this process. */
  RUN_WORKER: bool.default(true),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty variables (e.g. `OPENAI_API_KEY=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
