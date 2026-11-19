import type { ModelRegistry } from "../models/registry.js";
import type { SourcePassage, TextTurn } from "../models/types.js";
import { queryTokens } from "../knowledge/tokenize.js";

/** Alias used for cheap auxiliary calls; falls back to the assistant's own alias. */
export function auxAlias(models: ModelRegistry, fallback: string): string {
  return models.hasAlias("fast") ? "fast" : fallback;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Turn a follow-up ("and how much does it cost?") into a standalone search query,
 * so retrieval finds the right documents. Uses a fast model when available and
 * enabled, otherwise prepends the previous question for short follow-ups.
 */
export async function contextualQuery(
  models: ModelRegistry,
  p: { alias: string; question: string; history: TextTurn[]; useModel: boolean; signal?: AbortSignal },
): Promise<string> {
  const lastUser = [...p.history].reverse().find((t) => t.role === "user")?.content;
  if (!lastUser) return p.question;
  if (p.useModel) {
    const transcript = p.history
      .slice(-6)
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${clip(t.content.replace(/\s+/g, " "), 500)}`)
      .join("\n");
    const out = await models.complete(p.alias, {
      system:
        "You rewrite the user's latest message into one standalone search query for a documentation search engine. " +
        "Resolve pronouns and references using the conversation. Keep the user's language and key terms. " +
        "If the message is already standalone, return it unchanged. Output only the query, no quotes or explanation.",
      prompt: `<conversation>\n${transcript}\n</conversation>\n\nLatest message: ${p.question}`,
      maxOutputTokens: 120,
      timeoutMs: 4000,
      ...(p.signal ? { signal: p.signal } : {}),
    });
    const line = out?.split("\n").map((l) => l.trim()).find(Boolean);
    if (line && line.length <= 500) return line.replace(/^["'“]|["'”]$/g, "");
  }
  // Heuristic: short follow-ups inherit the previous question's terms.
  return queryTokens(p.question).length < 6 ? `${lastUser} ${p.question}` : p.question;
}

/** Up to three short follow-up questions, in the user's language. */
export async function suggestFollowUps(
  models: ModelRegistry,
  p: { alias: string; question: string; answer: string; sources: SourcePassage[]; signal?: AbortSignal },
): Promise<string[]> {
  if (!p.answer.trim()) return [];
  const titles = [...new Set(p.sources.map((s) => s.title))].slice(0, 8).join("; ");
  const out = await models.complete(p.alias, {
    system:
      "You suggest follow-up questions a website visitor might ask next. Write each in the same language as the visitor's " +
      "question, from the visitor's point of view, at most 12 words, answerable from the listed documentation topics. " +
      "Output 2 or 3 questions, one per line, with no numbering or extra text. Output nothing if no useful follow-up exists.",
    prompt: `Visitor question: ${clip(p.question, 600)}\n\nAnswer given: ${clip(p.answer, 2000)}\n\nDocumentation topics: ${titles || "(none)"}`,
    maxOutputTokens: 200,
    timeoutMs: 6000,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'“]|["'”]$/g, "").trim())
    .filter((l) => l.length >= 3 && l.length <= 140 && !/^(none|n\/a)$/i.test(l))
    .slice(0, 3);
}

/** A short summary of a conversation for human agents (handoff). */
export async function summarizeForHandoff(
  models: ModelRegistry,
  p: { alias: string; transcript: { role: string; content: string }[]; reason: string | null },
): Promise<string | null> {
  if (!p.transcript.length) return null;
  const text = p.transcript
    .slice(-20)
    .map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${clip(t.content.replace(/\s+/g, " "), 800)}`)
    .join("\n");
  return models.complete(p.alias, {
    system:
      "Summarize a support conversation for the human agent taking over. In English, at most 5 short bullet points: " +
      "what the visitor wants, relevant details they gave, what the assistant already tried or answered, and what is still open.",
    prompt: `${p.reason ? `Handoff reason: ${p.reason}\n\n` : ""}${text}`,
    maxOutputTokens: 300,
    timeoutMs: 8000,
  });
}
