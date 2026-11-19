/**
 * Turn files and fetched resources into markdown-ish text for chunking.
 * Supported: HTML, Markdown, plain text (and CSV/JSON as text), PDF, DOCX.
 * Parsers load lazily so the server starts fast and only pays for what it uses.
 */
import { extractPage } from "./html.js";

export interface ExtractedDocument {
  title: string;
  text: string;
  /** Canonical URL declared by an HTML page. */
  canonical?: string | null;
}

export type DocumentKind = "html" | "markdown" | "text" | "pdf" | "docx";

export class UnsupportedDocumentError extends Error {}

/** Decide how to read a resource from its content type, file name and first bytes. */
export function detectKind(contentType: string, name: string, bytes: Buffer): DocumentKind | null {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  const ext = /\.([a-z0-9]+)$/i.exec(name.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase() ?? "";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-" || ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") {
    return bytes.subarray(0, 2).toString("latin1") === "PK" ? "docx" : null;
  }
  if (ct === "text/html" || ct === "application/xhtml+xml" || ext === "html" || ext === "htm") return "html";
  if (ct === "text/markdown" || ct === "text/x-markdown" || ["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (ct.startsWith("text/") || ["txt", "csv", "tsv", "json", "yaml", "yml", "rst", "adoc"].includes(ext) || ct === "application/json") {
    return /^\s*<(!doctype html|html)[\s>]/i.test(bytes.subarray(0, 512).toString("utf8")) ? "html" : "text";
  }
  // Unknown types: accept only if it decodes as text.
  const sample = bytes.subarray(0, 4096).toString("utf8");
  if (!sample.includes("�") && !/[\x00-\x08\x0E-\x1F]/.test(sample)) return /^\s*</.test(sample) ? "html" : "text";
  return null;
}

/** Title from the first markdown heading, else from the name. */
function titleOf(text: string, name: string): string {
  const h = /^\s*#\s+(.+)$/m.exec(text);
  if (h) return h[1]!.trim().slice(0, 500);
  const base = decodeURIComponent(name.split(/[?#]/)[0]!.split("/").filter(Boolean).pop() ?? name);
  return base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 500) || "Untitled";
}

/** Strip YAML front matter, keeping its title if any. */
function frontMatter(md: string): { title: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  if (!m) return { title: null, body: md };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { title: t ? t[1]!.trim() : null, body: md.slice(m[0].length) };
}

export async function extractDocument(bytes: Buffer, o: { contentType: string; name: string; baseUrl?: string }): Promise<ExtractedDocument> {
  const kind = detectKind(o.contentType, o.name, bytes);
  if (!kind) throw new UnsupportedDocumentError(`unsupported file type (${o.contentType || o.name})`);
  switch (kind) {
    case "html": {
      const page = extractPage(bytes.toString("utf8"), o.baseUrl ?? "https://invalid.local/");
      return { title: page.title === (o.baseUrl ?? "https://invalid.local/") ? titleOf(page.text, o.name) : page.title, text: page.text, canonical: o.baseUrl ? page.canonical : null };
    }
    case "markdown": {
      const { title, body } = frontMatter(bytes.toString("utf8").replace(/^﻿/, ""));
      return { title: title ?? titleOf(body, o.name), text: body.trim() };
    }
    case "text": {
      const text = bytes.toString("utf8").replace(/^﻿/, "").trim();
      return { title: titleOf(text, o.name), text };
    }
    case "pdf":
      return extractPdf(bytes, o.name);
    case "docx":
      return extractDocx(bytes, o.name);
  }
}

async function extractPdf(bytes: Buffer, name: string): Promise<ExtractedDocument> {
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const [{ text }, meta] = await Promise.all([extractText(pdf, { mergePages: false }), getMeta(pdf).catch(() => null)]);
    const pages = text.map((t) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()).filter(Boolean);
    if (!pages.length) throw new UnsupportedDocumentError("the PDF has no extractable text (scanned images need OCR first)");
    const title = typeof meta?.info?.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim().slice(0, 500) : titleOf("", name);
    // Page markers become headings, so citations can point people to the right page.
    const body = pages.length > 1 ? pages.map((p, i) => `## Page ${i + 1}\n\n${p}`).join("\n\n") : pages[0]!;
    return { title, text: body };
  } finally {
    // Free pdf.js resources (method exists at runtime but is not in the published types).
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
}

async function extractDocx(bytes: Buffer, name: string): Promise<ExtractedDocument> {
  const mammoth = (await import("mammoth")).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: bytes });
  const page = extractPage(`<main>${html}</main>`, "https://invalid.local/");
  if (!page.text.trim()) throw new UnsupportedDocumentError("the document has no text");
  return { title: titleOf(page.text, name), text: page.text };
}

/**
 * Links listed in an llms.txt file (https://llmstxt.org): markdown links,
 * resolved against the file's URL, in order, without duplicates.
 */
export function parseLlmsTxt(md: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    try {
      const u = new URL(m[1]!, baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      const s = u.toString();
      if (!out.includes(s)) out.push(s);
    } catch {
      /* skip */
    }
  }
  return out;
}
