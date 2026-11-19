import type { Hono } from "hono";
import { z } from "zod";
import { metrics } from "../../lib/metrics.js";
import { safeEqual, sha256 } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";
import { openApiDocument, route } from "../define.js";
import type { AppEnv, Services } from "../env.js";
import { bearer } from "../middleware.js";

const Health = z.object({ status: z.enum(["ok", "unavailable"]), version: z.string() });

export function opsRoutes(app: Hono<AppEnv>, s: Services): void {
  route(app, { method: "get", path: "/healthz", tag: "Ops", summary: "Liveness", auth: "none", response: { status: 200, schema: Health } },
    (c) => c.json({ status: "ok" as const, version: s.version }));

  route(app, { method: "get", path: "/readyz", tag: "Ops", summary: "Readiness (database reachable)", auth: "none", response: { status: 200, schema: Health } },
    async (c) => {
      try {
        await s.sql`SELECT 1`;
        return c.json({ status: "ok" as const, version: s.version });
      } catch {
        return c.json({ status: "unavailable" as const, version: s.version }, 503);
      }
    });

  route(app, { method: "get", path: "/metrics", tag: "Ops", summary: "Prometheus metrics", auth: "none", response: { status: 200, description: "Prometheus text format", contentType: "text/plain" } },
    async (c) => {
      if (s.cfg.METRICS_TOKEN) {
        const token = bearer(c) ?? "";
        if (!safeEqual(sha256(token), sha256(s.cfg.METRICS_TOKEN))) throw unauthorized();
      }
      const extra = `# HELP ea_active_runs Runs executing in this process\n# TYPE ea_active_runs gauge\nea_active_runs ${s.executor.activeCount}\n`;
      return c.text(metrics.render() + "\n" + extra, 200, { "content-type": "text/plain; version=0.0.4" });
    });

  app.get("/openapi.json", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(openApiDocument(s.cfg.PUBLIC_BASE_URL, s.version));
  });
}
