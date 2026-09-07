import { buildLikeSearchPlan } from "./full-text-fallback.js";

/**
 * Natural-language query preparation for FTS5.
 *
 * FTS5 ANDs the terms of a multi-word query by default. Passing a question
 * through verbatim ("how did we undo that broken release?") requires every
 * word to co-occur in a single document, which effectively never happens —
 * an eight-word question returns zero rows by construction. A naive grep
 * that ORs its terms beats that on real corpora.
 *
 * Strategy (per issue #309):
 *  1. Tokenize the query and drop English stopwords (they carry no
 *     discriminative power but participate in the AND).
 *  2. Try the remaining content terms as an AND (most precise).
 *  3. If AND matches nothing, fall back to OR ranked by BM25 (matches the
 *     grep baseline's behavior of OR-ing terms, but with ranking).
 *  4. If OR also matches nothing because the question's vocabulary does not
 *     overlap the corpus at all (porter stems diverge, e.g. "undo" never
 *     stems to "revert"), fall back to a substring LIKE scan so the query
 *     still finds raw text matches instead of returning an empty result.
 */

export type Fts5PreparedQuery = {
  /** Normalized content terms (lowercased, stopwords dropped, deduped). */
  terms: string[];
  /** FTS5 MATCH expression ANDing the quoted terms. */
  and: string;
  /** FTS5 MATCH expression ORing the quoted terms. */
  or: string;
};

/** Common English stopwords — no discriminative power in an AND query. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while",
  "at", "by", "for", "with", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "to", "from", "up", "down", "in",
  "out", "on", "off", "over", "under", "again", "further", "once", "of",
  "here", "there", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "as", "is", "am", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "having", "do", "does", "did",
  "doing", "would", "should", "could", "ought", "i", "you", "he", "she",
  "it", "we", "they", "them", "his", "her", "their", "our", "your", "my",
  "its", "me", "him", "us", "this", "that", "these", "those", "what",
  "which", "who", "whom", "how", "why", "where", "can", "will", "shall",
  "may", "might", "must", "let", "make", "made", "get", "got", "go", "went",
  "say", "said", "tell", "told", "know", "knew", "think", "thought", "want",
  "wanted", "use", "used", "using", "way", "thing", "things", "something",
  "anything", "everything", "nothing", "someone", "anyone", "everyone",
  "somewhere", "anywhere", "everywhere", "s", "t", "d", "ll", "re", "ve",
]);

/**
 * Split on anything that is not a Unicode letter or number — mirrors the
 * default unicode61 tokenizer, which keeps accented letters (e.g. "cómo"
 * stays one token) and discards punctuation.
 */
const TERM_SPLIT_RE = /[^\p{L}\p{N}]+/u;

function quote(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

function dedupe(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (!seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

/**
 * Tokenize a free-text query into content terms: split on non-word
 * characters, lowercase, drop stopwords, dedupe in order.
 *
 * If every word is a stopword, the original words are kept as terms so the
 * query still searches for something rather than nothing.
 */
export function extractQueryTerms(raw: string): string[] {
  const words = dedupe(
    raw
      .toLowerCase()
      .split(TERM_SPLIT_RE)
      .filter(Boolean),
  );

  const terms = words.filter((word) => !STOPWORDS.has(word));
  if (terms.length > 0) {
    return terms;
  }
  // All-stopword query: keep the raw words so we search for something.
  return words;
}

/**
 * Prepare a natural-language query for FTS5 MATCH.
 *
 * Returns quoted AND and OR expressions over the content terms, or null
 * when the query has no usable terms at all (e.g. empty or punctuation-only).
 */
export function prepareFts5Query(raw: string): Fts5PreparedQuery | null {
  const terms = extractQueryTerms(raw);
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map(quote);
  return { terms, and: quoted.join(" "), or: quoted.join(" OR ") };
}

/**
 * True when an FTS5 "no rows" outcome should be retried as a substring
 * LIKE scan: the query has at least two content terms. Single-term queries
 * keep strict semantics — if FTS found nothing for one term, a LIKE scan
 * would only surface the stemmed form as a fuzzy substring match, which is
 * noise for an explicit keyword lookup.
 */
export function shouldRetryWithLike(prepared: Fts5PreparedQuery): boolean {
  return prepared.terms.length > 1;
}

/**
 * LIKE-search arguments for the prepared terms (the substring plan used
 * when FTS cannot match the vocabulary at all). Mirrors the existing
 * full-text fallback, but ORs terms — a natural-language question should
 * rank any term hit, not require all of them.
 */
export function likePlanForPreparedQuery(
  column: string,
  prepared: Fts5PreparedQuery,
): { terms: string[]; where: string[]; args: string[] } {
  const plan = buildLikeSearchPlan(column, prepared.terms.join(" "));
  return { terms: plan.terms, where: plan.where, args: plan.args };
}
