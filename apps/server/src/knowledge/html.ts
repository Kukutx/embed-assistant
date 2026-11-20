import { parse, type HTMLElement, type Node, NodeType } from "node-html-parser";

export interface ExtractedPage {
  title: string;
  text: string;
  canonical: string | null;
  links: string[];
  /** `<meta name="robots">` asks crawlers not to index the page / not to follow its links. */
  noindex: boolean;
  nofollow: boolean;
}

const DROP = "script,style,noscript,svg,canvas,iframe,form,nav,footer,header,aside,template,[aria-hidden=true],[hidden]";

/** Readable text (markdown-ish, keeps headings and lists) from an HTML page. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const meta = (sel: string) => decode(root.querySelector(sel)?.getAttribute("content")?.trim() ?? "");
  const h1 = decode(root.querySelector("h1")?.text.replace(/\s+/g, " ").trim() ?? "");
  const title =
    meta("meta[property='og:title']") ||
    pageTitle(decode(root.querySelector("title")?.text.replace(/\s+/g, " ").trim() ?? ""), h1, meta("meta[property='og:site_name']") || meta("meta[name='application-name']")) ||
    h1 ||
    baseUrl;
  const canonicalHref = root.querySelector("link[rel='canonical']")?.getAttribute("href");
  const robots = root
    .querySelectorAll("meta[name]")
    .filter((m) => /^(robots|embed-assistant)$/i.test(m.getAttribute("name") ?? ""))
    .map((m) => (m.getAttribute("content") ?? "").toLowerCase())
    .join(",");
  const links = root
    .querySelectorAll("a[href]")
    .filter((a) => !/\bnofollow\b/i.test(a.getAttribute("rel") ?? ""))
    .map((a) => resolve(a.getAttribute("href")!, baseUrl))
    .filter((u): u is string => u !== null);

  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
  for (const el of main.querySelectorAll(DROP)) el.remove();
  const out: string[] = [];
  walk(main, out);
  const text = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return {
    title: title.slice(0, 500),
    text,
    canonical: canonicalHref ? resolve(canonicalHref, baseUrl) : null,
    links,
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
  };
}

const TITLE_SEPARATOR = /\s+[|\u2013\u2014\u00b7:•»-]{1,2}\s+/g;

/**
 * The page's own name from its `<title>`, without the site name that most sites add
 * ("Opening hours | Example City" becomes "Opening hours"): the part that matches the
 * page's h1, else the title without a leading or trailing site name.
 */
export function pageTitle(title: string, h1: string, siteName: string): string {
  const seps = [...title.matchAll(TITLE_SEPARATOR)];
  if (!seps.length) return title;
  const same = (a: string, b: string) => a.trim().localeCompare(b.trim(), undefined, { sensitivity: "base" }) === 0;
  const bounds = [0, ...seps.flatMap((m) => [m.index!, m.index! + m[0].length]), title.length];
  const parts: string[] = [];
  for (let i = 0; i < bounds.length; i += 2) parts.push(title.slice(bounds[i], bounds[i + 1]));
  if (h1) {
    const match = parts.find((x) => same(x, h1));
    if (match) return match.trim();
  }
  if (siteName) {
    const first = seps[0]!;
    const last = seps.at(-1)!;
    if (same(parts.at(-1)!, siteName)) return title.slice(0, last.index).trim();
    if (same(parts[0]!, siteName)) return title.slice(first.index! + first[0].length).trim();
  }
  return title;
}

function walk(node: Node, out: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(decode(node.rawText).replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase() ?? "";
  const h = /^h([1-6])$/.exec(tag);
  if (h) {
    out.push(`\n\n${"#".repeat(Number(h[1]))} ${decode(el.text).replace(/\s+/g, " ").trim()}\n\n`);
    return;
  }
  if (tag === "pre") {
    out.push(`\n\n${decode(el.text)}\n\n`);
    return;
  }
  if (tag === "br") {
    out.push("\n");
    return;
  }
  if (tag === "li") out.push("\n- ");
  const block = /^(p|div|section|article|ul|ol|table|tr|blockquote|dl|dt|dd|figure|main)$/.test(tag);
  if (block) out.push("\n\n");
  if (tag === "td" || tag === "th") out.push(" | ");
  for (const child of el.childNodes) walk(child, out);
  if (block) out.push("\n\n");
}

function resolve(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** <loc> entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]!.trim()));
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}
