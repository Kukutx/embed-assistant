import { parse, type HTMLElement, type Node, NodeType } from "node-html-parser";

export interface ExtractedPage {
  title: string;
  text: string;
  canonical: string | null;
  links: string[];
}

const DROP = "script,style,noscript,svg,canvas,iframe,form,nav,footer,header,aside,template,[aria-hidden=true],[hidden]";

/** Readable text (markdown-ish, keeps headings and lists) from an HTML page. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title =
    root.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    root.querySelector("title")?.text.trim() ||
    root.querySelector("h1")?.text.trim() ||
    baseUrl;
  const canonicalHref = root.querySelector("link[rel='canonical']")?.getAttribute("href");
  const links = root
    .querySelectorAll("a[href]")
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
  return { title: decode(title).slice(0, 500), text, canonical: canonicalHref ? resolve(canonicalHref, baseUrl) : null, links };
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
