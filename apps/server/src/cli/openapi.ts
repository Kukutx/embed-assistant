/** Print the OpenAPI document without a database: `pnpm --filter @embed-assistant/server openapi > openapi.json` */
import { Hono } from "hono";
import { loadConfig } from "../config.js";
import { openApiDocument } from "../http/define.js";
import type { AppEnv, Services } from "../http/env.js";
import { adminRoutes } from "../http/routes/admin.js";
import { chatRoutes } from "../http/routes/chat.js";
import { opsRoutes } from "../http/routes/ops.js";
import { publicRoutes } from "../http/routes/public.js";
import { serverVersion } from "../services.js";

const cfg = loadConfig({ SECRET_KEY: "x".repeat(32), ...process.env });
const app = new Hono<AppEnv>();
// Route registration only records specs; handlers never run here.
const s = { cfg } as unknown as Services;
opsRoutes(app, s);
publicRoutes(app, s, null as never);
chatRoutes(app, s);
adminRoutes(app, s, null as never);
process.stdout.write(JSON.stringify(openApiDocument(cfg.PUBLIC_BASE_URL, serverVersion()), null, 2) + "\n");
