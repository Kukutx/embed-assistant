import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ErrorCode, type ErrorBody } from "@embed-assistant/protocol";
import { ApiError } from "../lib/errors.js";
import type { AppEnv, Services } from "./env.js";
import { adminAuth, publicCors, requestContext, sessionAuth, WidgetCache } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { adminAgentRoutes } from "./routes/adminAgent.js";
import { mcpRoutes } from "../mcp/server.js";
import { adminMcpRoutes } from "./routes/adminMcp.js";
import { chatRoutes } from "./routes/chat.js";
import { opsRoutes } from "./routes/ops.js";
import { publicRoutes } from "./routes/public.js";
import { serveDir } from "./static.js";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server/{src,dist}/http -> repository root */
const repoRoot = join(here, "..", "..", "..", "..");

export function resolveWidgetDir(configured: string | undefined): string {
  return configured ?? join(repoRoot, "packages", "widget", "dist");
}
export const CONSOLE_DIR = join(here, "..", "..", "static");

const tooLarge = (c: Context) => {
  const body: ErrorBody = { error: { code: ErrorCode.BadRequest, message: "request body too large" } };
  return c.json(body, 413);
};
const publicBodyLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });

export function createApp(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const widgets = new WidgetCache(s.sql);

  app.use("*", requestContext(s));
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ApiError) {
      if (err.retryAfterSeconds) c.header("Retry-After", String(err.retryAfterSeconds));
      const body: ErrorBody = { error: { code: err.code, message: err.message, requestId, ...(err.details !== undefined ? { details: err.details } : {}) } };
      return c.json(body, err.status as 400);
    }
    s.log.error({ err, requestId, path: c.req.path }, "unhandled error");
    const body: ErrorBody = { error: { code: ErrorCode.Internal, message: "internal error", requestId } };
    return c.json(body, 500);
  });
  app.notFound((c) => {
    const body: ErrorBody = { error: { code: ErrorCode.NotFound, message: "route not found", requestId: c.get("requestId") } };
    return c.json(body, 404);
  });

  // Public widget API: CORS for any origin, allowlist enforced per widget in the handlers.
  // Note: in Hono "/x/*" also matches "/x", so each prefix is listed once.
  for (const p of ["/v1/widgets/*", "/v1/sessions", "/v1/conversations/*", "/v1/runs/*", "/v1/messages/*"]) {
    app.use(p, publicCors());
  }
  // Bound request bodies before anything parses them.
  app.use("/v1/admin/*", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooLarge }));
  app.use("/mcp", bodyLimit({ maxSize: 256 * 1024, onError: tooLarge }));
  app.use("/v1/*", async (c, next) => (c.req.path.startsWith("/v1/admin/") ? next() : publicBodyLimit(c, next)));
  const chatAuth = sessionAuth(s, widgets);
  for (const p of ["/v1/conversations/*", "/v1/runs/*", "/v1/messages/*"]) {
    app.use(p, async (c, next) => (c.req.method === "OPTIONS" ? next() : chatAuth(c, next)));
  }
  app.use("/v1/admin/*", adminAuth(s));

  opsRoutes(app, s);
  publicRoutes(app, s, widgets);
  chatRoutes(app, s);
  adminRoutes(app, s, widgets);
  adminAgentRoutes(app, s);
  adminMcpRoutes(app, s);
  mcpRoutes(app, s);

  if (s.cfg.SERVE_WIDGET) {
    const widgetDir = resolveWidgetDir(s.cfg.WIDGET_DIST_DIR);
    if (!existsSync(widgetDir)) s.log.warn({ widgetDir }, "widget bundle not found; run `pnpm build` (serving /widget disabled)");
    const serveWidget = serveDir({
      root: widgetDir,
      cors: true,
      // Content-hashed bundles are immutable; the loader and unhashed aliases revalidate quickly.
      cacheControl: (rel) => (/\.[0-9a-f]{8,}\.js$/.test(rel) ? "public, max-age=31536000, immutable" : "public, max-age=300"),
    });
    app.get("/widget/*", async (c) => (await serveWidget(c, c.req.path.slice("/widget/".length))) ?? c.notFound());
  }

  if (s.cfg.SERVE_CONSOLE) {
    const serveConsole = serveDir({
      root: CONSOLE_DIR,
      cacheControl: () => "no-cache",
      headers: {
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      },
    });
    const demoHeaders = serveDir({ root: CONSOLE_DIR, cacheControl: () => "no-cache" });
    app.get("/", (c) => c.redirect("/admin/"));
    app.get("/admin", (c) => c.redirect("/admin/"));
    app.get("/admin/*", async (c) => (await serveConsole(c, `admin/${c.req.path.slice("/admin/".length) || "index.html"}`)) ?? c.notFound());
    // The demo page embeds the widget like a third-party site would, so it gets no restrictive CSP.
    app.get("/demo", async (c) => (await demoHeaders(c, "demo.html")) ?? c.notFound());
  }

  return app;
}
