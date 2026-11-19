/**
 * Small, safe Markdown renderer that builds DOM nodes directly (never innerHTML),
 * so model output cannot inject markup or scripts. Supports what assistants
 * actually produce: paragraphs, headings, lists, quotes, fenced code, tables,
 * emphasis, inline code, links, and citation markers like [1].
 * Tolerates incomplete input while an answer is still streaming.
 */

export interface RenderOptions {
  /** Build the element for a citation marker [n]; return null to render it as text. */
  citation?: (n: number) => Node | null;
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw, "https://invalid.example/");
    if (!SAFE_PROTOCOLS.has(u.protocol) || u.hostname === "invalid.example") return null;
    return u.href;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|\*([^*\s](?:[\s\S]*?[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[(\d{1,2})\]|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*])/g;

export function renderInline(text: string, parent: Node, opts: RenderOptions): void {
  let last = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      const code = el("code");
      code.textContent = m[2].replace(/^ (.*) $/, "$1");
      parent.appendChild(code);
    } else if (m[3] !== undefined) {
      const b = el("strong");
      renderInline(m[3], b, opts);
      parent.appendChild(b);
    } else if (m[4] !== undefined) {
      const i = el("em");
      renderInline(m[4], i, opts);
      parent.appendChild(i);
    } else if (m[5] !== undefined && m[6] !== undefined) {
      const href = safeUrl(m[6]);
      if (href) {
        const a = el("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        renderInline(m[5], a, opts);
        parent.appendChild(a);
      } else {
        renderInline(m[5], parent, opts);
      }
    } else if (m[7] !== undefined) {
      const node = opts.citation?.(Number(m[7]));
      parent.appendChild(node ?? document.createTextNode(m[0]));
    } else if (m[8] !== undefined) {
      const href = safeUrl(m[8]);
      if (href) {
        const a = el("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        a.textContent = m[8];
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(m[8]));
    }
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

const isFence = (l: string) => /^\s*(```|~~~)/.test(l);
const isHeading = (l: string) => /^\s{0,3}#{1,6}\s+/.test(l);
const isBullet = (l: string) => /^\s*[-*+]\s+/.test(l);
const isOrdered = (l: string) => /^\s*\d{1,3}[.)]\s+/.test(l);
const isQuote = (l: string) => /^\s*>/.test(l);
const isRule = (l: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdown(src: string, opts: RenderOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3);
      const lang = line.trim().slice(3).trim().split(/\s/)[0] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      i++; // closing fence (or end of streaming input)
      const pre = el("pre");
      const code = el("code");
      if (lang) code.dataset.lang = lang.replace(/[^\w+-]/g, "");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }
    if (isHeading(line)) {
      const level = /^\s*(#+)/.exec(line)![1]!.length;
      const h = el(level <= 2 ? "h3" : "h4");
      renderInline(line.replace(/^\s*#+\s+/, "").replace(/\s+#+\s*$/, ""), h, opts);
      frag.appendChild(h);
      i++;
      continue;
    }
    if (isRule(line)) {
      frag.appendChild(el("hr"));
      i++;
      continue;
    }
    if (isQuote(line)) {
      const body: string[] = [];
      while (i < lines.length && isQuote(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      const q = el("blockquote");
      q.appendChild(renderMarkdown(body.join("\n"), opts));
      frag.appendChild(q);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const table = el("table");
      const head = el("thead");
      const tr = el("tr");
      for (const cell of splitRow(line)) {
        const th = el("th");
        renderInline(cell, th, opts);
        tr.appendChild(th);
      }
      head.appendChild(tr);
      table.appendChild(head);
      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        const row = el("tr");
        for (const cell of splitRow(lines[i]!)) {
          const td = el("td");
          renderInline(cell, td, opts);
          row.appendChild(td);
        }
        tbody.appendChild(row);
        i++;
      }
      table.appendChild(tbody);
      const wrap = el("div", "ea-table");
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }
    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const list = el(ordered ? "ol" : "ul");
      if (ordered) {
        const start = Number(/^\s*(\d+)/.exec(line)![1]);
        if (start !== 1) (list as HTMLOListElement).start = start;
      }
      const baseIndent = /^\s*/.exec(line)![0].length;
      let item: HTMLLIElement | null = null;
      let itemLines: string[] = [];
      const flushItem = () => {
        if (!item) return;
        const content = itemLines.join("\n");
        // Tight items render inline; items with nested blocks render as blocks.
        if (/\n\s*([-*+]|\d{1,3}[.)])\s+|\n\s*```/.test(content)) item.appendChild(renderMarkdown(content, opts));
        else renderInline(content.replace(/\n\s*/g, " "), item, opts);
        list.appendChild(item);
      };
      while (i < lines.length) {
        const l = lines[i]!;
        const indent = /^\s*/.exec(l)![0].length;
        const sameLevel = indent <= baseIndent + 1 && (ordered ? isOrdered(l) : isBullet(l));
        if (sameLevel) {
          flushItem();
          item = el("li");
          itemLines = [l.replace(/^\s*([-*+]|\d{1,3}[.)])\s+/, "")];
          i++;
        } else if (l.trim() && (indent > baseIndent || !(isHeading(l) || isFence(l) || isQuote(l) || isBullet(l) || isOrdered(l))) && indent >= baseIndent + 2) {
          itemLines.push(l.slice(Math.min(indent, baseIndent + 2)));
          i++;
        } else if (!l.trim() && i + 1 < lines.length && /^\s+/.test(lines[i + 1]!) && lines[i + 1]!.trim()) {
          itemLines.push("");
          i++;
        } else break;
      }
      flushItem();
      frag.appendChild(list);
      continue;
    }
    // Paragraph: consecutive lines until a blank line or another block starts.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !isFence(lines[i]!) &&
      !isHeading(lines[i]!) &&
      !isQuote(lines[i]!) &&
      !isBullet(lines[i]!) &&
      !isOrdered(lines[i]!) &&
      !(para.length === 0 ? false : isRule(lines[i]!))
    ) {
      para.push(lines[i++]!);
    }
    if (para.length === 0) {
      // Safety valve: a line no block rule consumed.
      para.push(lines[i++]!);
    }
    const p = el("p");
    para.forEach((l, idx) => {
      if (idx > 0) p.appendChild(el("br"));
      renderInline(l.trim(), p, opts);
    });
    frag.appendChild(p);
  }
  return frag;
}

/** Plain text for copy-to-clipboard: drop citation markers. */
export function plainText(md: string): string {
  return md.replace(/\s?\[(\d{1,2})\](?!\()/g, "").trim();
}
