/**
 * Language-neutral tokenisation for Postgres 'simple' full-text search.
 * Latin/Cyrillic/... text splits on non-letters; CJK runs (which have no
 * spaces) become overlapping bigrams, the standard trick for CJK search
 * without a segmentation dictionary.
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const WORD = /[\p{L}\p{N}]+/gu;

// Small multilingual stoplist applied to QUERIES only (documents keep every token).
const STOP = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my " +
    "no not of on or our please should so that the their them then there these they this to us was we were what " +
    "when where which who why will with would you your " +
    "il lo la le gli i un una uno di da del della dei delle e è che per con su come cosa sono non " +
    "der die das und ist ein eine zu den mit wie was " +
    "el los las de y en que un una por para como es " +
    "le les des du et est une pour dans comment"
  ).split(" "),
);
const CJK_STOP = new Set(["的", "了", "吗", "呢", "是", "我", "你", "怎么", "如何", "什么", "可以", "一个", "请问"]);

export function searchTokens(text: string): string[] {
  const out: string[] = [];
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(WORD)) {
    const word = match[0];
    let run = "";
    let kind: "cjk" | "other" | null = null;
    const flush = () => {
      if (!run) return;
      if (kind === "cjk") {
        const chars = Array.from(run);
        if (chars.length === 1) out.push(chars[0]!);
        else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i]! + chars[i + 1]!);
      } else {
        out.push(run);
      }
      run = "";
    };
    for (const ch of word) {
      const k = CJK.test(ch) ? "cjk" : "other";
      if (k !== kind) {
        flush();
        kind = k;
      }
      run += ch;
    }
    flush();
  }
  return out;
}

export function toSearchText(text: string): string {
  return searchTokens(text).join(" ");
}

const SUFFIXES = ["ations", "ation", "ments", "ment", "ings", "ing", "ions", "ion", "ies", "ed", "es", "ly", "s"];

/**
 * Crude, language-agnostic word-form folding for queries: strip one common
 * suffix so "embedding" also finds "embed" and "embedded". Matching then uses
 * prefix search, which works for many inflected languages without dictionaries.
 */
export function stem(token: string): string {
  if (CJK.test(token) || token.length < 5 || /\d/.test(token)) return token;
  for (const suf of SUFFIXES) {
    if (token.endsWith(suf) && token.length - suf.length >= 4) return token.slice(0, -suf.length);
  }
  return token;
}

/** Whether a query term should match by prefix (non-CJK words of 3+ chars). */
export const isPrefixTerm = (t: string): boolean => !CJK.test(t) && t.length >= 3;

/** Distinct, meaningful, folded query terms (max 32). */
export function queryTokens(question: string): string[] {
  const seen = new Set<string>();
  for (const t of searchTokens(question)) {
    if (STOP.has(t) || CJK_STOP.has(t)) continue;
    if (t.length < 2 && !CJK.test(t) && !/\d/.test(t)) continue;
    seen.add(stem(t));
    if (seen.size >= 32) break;
  }
  return [...seen];
}

/**
 * True when any document token matches the query term: exact for CJK; for words, by prefix
 * ("embed" finds "embedding") or, for terms of 4+ letters, as the end of a compound
 * ("site" finds "website", "zahlung" finds "rechnungszahlung").
 */
export function termMatches(term: string, docTokens: Set<string>): boolean {
  if (docTokens.has(term)) return true;
  if (!isPrefixTerm(term)) return false;
  const tail = term.length >= 4;
  for (const d of docTokens) if (d.startsWith(term) || (tail && d.endsWith(term))) return true;
  return false;
}

/** OR query for to_tsquery('simple', ...). Terms contain only letters/digits, so this is injection-safe. */
export function toTsQuery(tokens: string[]): string | null {
  const safe = tokens.filter((t) => /^[\p{L}\p{N}]+$/u.test(t));
  return safe.length ? safe.map((t) => (isPrefixTerm(t) ? `${t}:*` : t)).join(" | ") : null;
}
