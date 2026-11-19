import type { ChatChunk, ChatModel, ChatRequest } from "./types.js";

/**
 * Built-in, offline "model": answers by quoting the best matching passages.
 * It never invents text, needs no API key and keeps the product usable when
 * every LLM provider is down or not configured yet. Replies in English.
 */
export class ExtractiveChat implements ChatModel {
  readonly provider = "builtin";
  readonly model = "extractive";
  constructor(readonly id = "extractive") {}

  available(): boolean {
    return true;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const top = req.sources.slice(0, 3);
    let text: string;
    if (top.length === 0) {
      text =
        "I couldn't find anything about that in the documentation I have access to. " +
        "Try rephrasing your question, or contact the support team.";
    } else {
      const parts = top.map((s) => {
        const excerpt = summarize(s.content, 420);
        return `**${s.heading ?? s.title}** [${s.index}]\n\n${excerpt}`;
      });
      text = `Here is what I found in the documentation:\n\n${parts.join("\n\n")}`;
    }
    // Stream in small pieces so the client experience matches real models.
    const tokens = text.match(/\S+\s*|\s+/g) ?? [text];
    for (const t of tokens) {
      if (req.signal.aborted) return;
      yield { type: "text", text: t };
    }
    yield { type: "usage", inputTokens: 0, outputTokens: 0 };
  }
}

function summarize(content: string, max: number): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("。"));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")) + " …";
}
