import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticOptions {
  root: string;
  /** Cache-Control for a given relative path. */
  cacheControl: (rel: string) => string;
  /** Allow any origin to load these files (widget scripts are embedded cross-origin). */
  cors?: boolean;
  headers?: Record<string, string>;
}

/** Minimal static file responder with traversal protection and in-memory caching in production. */
export function serveDir(opts: StaticOptions) {
  const root = normalize(opts.root);
  const cache = new Map<string, { body: Uint8Array<ArrayBuffer>; etag: string }>();
  const production = process.env.NODE_ENV === "production";

  return async (c: Context, rel: string): Promise<Response | null> => {
    const safe = normalize(join(root, rel || "index.html"));
    if (safe !== root && !safe.startsWith(root + sep)) return null;
    let entry = production ? cache.get(safe) : undefined;
    if (!entry) {
      try {
        const st = await stat(safe);
        if (!st.isFile()) return null;
        const body = new Uint8Array(await readFile(safe));
        entry = { body, etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` };
        if (production) cache.set(safe, entry);
      } catch {
        return null;
      }
    }
    const headers: Record<string, string> = {
      "content-type": TYPES[extname(safe)] ?? "application/octet-stream",
      "cache-control": opts.cacheControl(rel),
      etag: entry.etag,
      "x-content-type-options": "nosniff",
      ...opts.headers,
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = "*";
      headers["cross-origin-resource-policy"] = "cross-origin";
    }
    if (c.req.header("if-none-match") === entry.etag) return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : entry.body, { status: 200, headers });
  };
}
