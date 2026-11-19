export interface Chunk {
  heading: string | null;
  content: string;
}

const TARGET = 1100;
const MAX = 1600;

/**
 * Split markdown-ish text into retrieval chunks of ~1k characters, never
 * across a heading, carrying the nearest heading path as context.
 */
export function chunkText(text: string, title: string): Chunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: { heading: string | null; body: string[] }[] = [];
  const path: string[] = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      if (current.body.join("").trim()) sections.push(current);
      const level = h[1]!.length;
      path.splice(level - 1);
      path[level - 1] = h[2]!.trim();
      current = { heading: path.filter(Boolean).join(" › ") || null, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join("").trim()) sections.push(current);

  const chunks: Chunk[] = [];
  for (const s of sections) {
    const paragraphs = s.body
      .join("\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => (p.length > MAX ? splitLong(p) : [p]));
    let buf = "";
    for (const p of paragraphs) {
      if (buf && buf.length + p.length + 2 > TARGET) {
        chunks.push({ heading: s.heading ?? title, content: buf });
        buf = "";
      }
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    if (buf) chunks.push({ heading: s.heading ?? title, content: buf });
  }
  return chunks;
}

function splitLong(p: string): string[] {
  const sentences = p.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [p];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > TARGET) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > MAX) {
      for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
