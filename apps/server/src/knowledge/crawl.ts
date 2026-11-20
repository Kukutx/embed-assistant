/**
 * Website crawling: start from one page and follow links, for sites without a
 * sitemap. Stays on the start page's origin and under its folder
 * (https://x.example/help/ crawls /help/...), honours robots.txt for `*` and
 * our own agent, and skips assets that cannot hold an answer.
 */
import { safeFetch } from "./safeFetch.js";

export const CRAWLER_AGENT = "embed-assistant";

const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|map|woff2?|ttf|otf|eot|zip|gz|tgz|rar|7z|tar|dmg|exe|msi|apk|mp[34]|m4a|wav|ogg|webm|mov|avi|xml|rss|atom|ics|json)$/i;
/** Query parameters that only track a visit; dropped so one page is fetched once. */
const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|_ga)$/i;

export interface Robots {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
}

/** The rules of the most specific group that applies to us (`embed-assistant`, else `*`). */
export function parseRobots(txt: string): Robots {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], allow: [], disallow: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.allow.push(value);
    if (key === "disallow" && value) current.disallow.push(value);
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && CRAWLER_AGENT.startsWith(a)));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow), sitemaps };
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${body.join(".*")}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; Allow wins a tie (RFC 9309). */
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  let best = -1;
  let allowed = true;
  for (const r of robots.disallow) if (ruleMatches(r, pathAndQuery) && r.length > best) [best, allowed] = [r.length, false];
  for (const r of robots.allow) if (ruleMatches(r, pathAndQuery) && r.length >= best) [best, allowed] = [r.length, true];
  return allowed;
}

/** One spelling per page: no fragment, no tracking parameters. Null for non-web links. */
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** The folder a crawl stays in: the start URL's directory on its origin. */
export function crawlScope(start: string): { origin: string; prefix: string } {
  const u = new URL(start);
  return { origin: u.origin, prefix: u.pathname.endsWith("/") ? u.pathname : u.pathname.replace(/[^/]*$/, "") };
}

export function inScope(url: string, scope: { origin: string; prefix: string }): boolean {
  const u = new URL(url);
  return u.origin === scope.origin && u.pathname.startsWith(scope.prefix) && !ASSET.test(u.pathname);
}

export async function fetchRobots(origin: string, opts: { allowPrivate: boolean }): Promise<Robots> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { ...opts, accept: "text/plain,*/*;q=0.5", maxBytes: 512 * 1024 });
    return res.status < 400 ? parseRobots(res.body) : { allow: [], disallow: [], sitemaps: [] };
  } catch {
    return { allow: [], disallow: [], sitemaps: [] };
  }
}

/**
 * Visit pages breadth-first from `seeds` with `concurrency` requests at a time,
 * up to `maxPages`. `visit` fetches and stores one page and returns its links.
 * Returns how many pages were visited.
 */
export async function crawl(
  seeds: string[],
  o: { maxPages: number; concurrency?: number; accept: (url: string) => boolean },
  visit: (url: string) => Promise<string[]>,
): Promise<number> {
  const concurrency = o.concurrency ?? 4;
  const queued = new Set<string>();
  const queue: string[] = [];
  const add = (u: string | null) => {
    if (!u || queued.has(u) || queued.size >= o.maxPages * 5 || !o.accept(u)) return;
    queued.add(u);
    queue.push(u);
  };
  seeds.forEach((s) => add(normalizeUrl(s)));
  let visited = 0;
  let inFlight = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < concurrency && queue.length && visited < o.maxPages) {
        const url = queue.shift()!;
        visited++;
        inFlight++;
        visit(url)
          .then((links) => links.forEach((l) => add(normalizeUrl(l, url))))
          .catch(() => {})
          .finally(() => {
            inFlight--;
            pump();
          });
      }
      if (inFlight === 0) resolve();
    };
    pump();
  });
  return visited;
}
