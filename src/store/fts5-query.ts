import { buildLikeSearchPlan } from "./full-text-fallback.js";
import { packStopwordsFor } from "./language-pack.js";
import type { LcmPaths } from "../lcm-paths.js";

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
 * English stopwords are always dropped. Other languages come from language
 * packs: a pack applies when the query carries its function words, so a
 * pt-BR question loses "que", "como", "para" the way an English one loses
 * "what", "how", "for". Without a pack, a question in that language goes
 * through whole, function words included.
 *
 * If every word is a stopword, the original words are kept as terms so the
 * query still searches for something rather than nothing.
 */
export function extractQueryTerms(raw: string, paths?: LcmPaths): string[] {
  const words = dedupe(
    raw
      .toLowerCase()
      .split(TERM_SPLIT_RE)
      .filter(Boolean),
  );

  let packStopwords: ReadonlySet<string> = new Set();
  try { packStopwords = paths ? packStopwordsFor(paths, words) : packStopwordsFor(words); } catch { /* no configured pack root */ }
  const terms = words.filter((word) => !STOPWORDS.has(word) && !packStopwords.has(word));
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
export function prepareFts5Query(raw: string, preExtracted?: readonly string[], paths?: LcmPaths): Fts5PreparedQuery | null {
  // `preExtracted` is the term set a caller already derived, and it is not the same thing as
  // extracting from `raw` again: a pivot query's union is two languages in one string, and a
  // second pass picks its stopword pack from the mixture, dropping terms one side had kept.
  const terms = preExtracted ? [...preExtracted] : extractQueryTerms(raw, paths);
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map(quote);
  return { terms, and: quoted.join(" "), or: quoted.join(" OR ") };
}

/**
 * The caller's query and the caller's own translation of it, combined into one
 * additive term set.
 *
 * Each side is tokenised on its own, so each loses its own language's function
 * words and neither side's leak into the other: a pt-BR question keeps its
 * content words while `que`/`como`/`para` go, and the English translation keeps
 * its own. The union then searches as one query — a hit through either side
 * counts, which is what an additive expansion means.
 *
 * Why additive rather than a replacement: the ceiling experiment behind this
 * (74 pt-BR questions, three corpora, translations from a model rather than
 * from the caller) scored the original alone at 0.486 hit@5, the translation
 * alone at 0.649, both ORed with the original's function words still in at
 * 0.473, and this combination at 0.716 — and the corpus whose own content is in
 * the author's language is the one where translating instead of adding loses.
 *
 * No pivot query, or one whose terms add nothing, returns `query` untouched, so
 * the single-language path is unchanged.
 */
export function combineWithPivotQuery(query: string, pathsOrPivot?: LcmPaths | string, suppliedPivot?: string): string {
  const paths = typeof pathsOrPivot === "string" ? undefined : pathsOrPivot;
  const pivotQuery = typeof pathsOrPivot === "string" ? pathsOrPivot : suppliedPivot;
  const terms = combinedQueryTerms(query, paths, pivotQuery);
  return terms ? terms.join(" ") : query;
}

/**
 * The final term set for `query` plus `pivotQuery`, or null when the pivot adds nothing and
 * the single-language path applies.
 *
 * Callers pass this to `prepareFts5Query` alongside the combined string. Handing the string
 * alone to a layer that re-extracts would undo the whole point: each side is tokenised here
 * against its own language's stopwords, and re-tokenising the mixture picks one pack for both.
 */
export function combinedQueryTerms(query: string, pathsOrPivot?: LcmPaths | string, suppliedPivot?: string): string[] | null {
  const paths = typeof pathsOrPivot === "string" ? undefined : pathsOrPivot;
  const pivotQuery = typeof pathsOrPivot === "string" ? pathsOrPivot : suppliedPivot;
  if (!pivotQuery || pivotQuery.trim().length === 0) return null;
  const terms = extractQueryTerms(query, paths);
  const pivotTerms = extractQueryTerms(pivotQuery, paths).filter((term) => !terms.includes(term));
  if (pivotTerms.length === 0) return null;
  return [...terms, ...pivotTerms];
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
