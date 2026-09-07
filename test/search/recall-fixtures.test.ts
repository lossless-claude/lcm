import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { RetrievalEngine } from "../../src/retrieval.js";
import { extractQueryTerms } from "../../src/store/fts5-query.js";

/**
 * Layer 1 recall benchmark (issue #309).
 *
 * A small synthetic corpus where question wording deliberately diverges from
 * document wording. Each question targets one session; `forbidden_terms`
 * guarantees the question shares no distinctive vocabulary with its own
 * transcript, so the benchmark cannot silently degrade into a keyword test.
 *
 * These fixtures prove no regression. They are NOT a quality score — the
 * corpus is small, clean, and nothing like a real one. Real numbers come
 * from `lcm bench` (Layer 2) against a user's own sessions.
 */

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "recall");
const RECALL_K = 5;
const RECALL_THRESHOLD = 0.6;
const EMPTY_RATE_THRESHOLD = 0.1;
const P95_LATENCY_MS = 500;

type RecallQuery = {
  id: string;
  session_id: string;
  question: string;
  forbidden_terms: string[];
  rationale: string;
};

type JsonlMessage = { message?: { role?: string; content?: unknown } };

function loadQueries(): RecallQuery[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "queries.json"), "utf-8")) as RecallQuery[];
}

function loadCorpus(): Map<string, Array<{ role: string; content: string }>> {
  const corpus = new Map<string, Array<{ role: string; content: string }>>();
  for (const file of readdirSync(join(FIXTURES_DIR, "corpus"))) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(/\.jsonl$/, "");
    const messages = readFileSync(join(FIXTURES_DIR, "corpus", file), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as JsonlMessage;
        return {
          role: parsed.message?.role ?? "user",
          content: String(parsed.message?.content ?? ""),
        };
      });
    corpus.set(sessionId, messages);
  }
  return corpus;
}

/** Content terms of a question with stopwords removed (same prep as search). */
function questionTerms(question: string): string[] {
  return extractQueryTerms(question);
}

/**
 * Stem equivalence via FTS5: insert a doc containing `surface`, then MATCH
 * the quoted `term` — a hit means the porter tokenizer maps both to the same
 * stem (e.g. "customers" ~ "customer"). One throwaway row per probe is fast
 * enough for a test corpus this size.
 */
function stemsEquivalent(probe: DatabaseSync, term: string, surface: string): boolean {
  probe.exec("DELETE FROM stemmer");
  probe.prepare("INSERT INTO stemmer(rowid, surface) VALUES (1, ?)").run(surface);
  const row = probe
    .prepare(`SELECT count(*) AS c FROM stemmer WHERE stemmer MATCH ?`)
    .get(`"${term.replace(/"/g, "")}"`) as { c: number };
  return row.c === 1;
}

function newStemmerProbe(): DatabaseSync {
  const probe = new DatabaseSync(":memory:");
  probe.exec(
    "CREATE VIRTUAL TABLE stemmer USING fts5(surface, tokenize='porter unicode61')",
  );
  return probe;
}

/** Memoized stem-equivalence probe (each probe rewrites the table). */
const stemEquivalenceCache = new Map<string, boolean>();

function stemsEquivalentCached(probe: DatabaseSync, term: string, surface: string): boolean {
  const key = `${term}\u0000${surface}`;
  const cached = stemEquivalenceCache.get(key);
  if (cached !== undefined) return cached;
  const result = stemsEquivalent(probe, term, surface);
  stemEquivalenceCache.set(key, result);
  return result;
}

/**
 * The grep baseline from the issue: an OR over raw transcript text, ranked
 * by term-hit count. Terms are matched stem-equivalently so the baseline is
 * not artificially handicapped by morphological variants ("customers" ~
 * "customer"); for stopword-only phrasings ("who"), which no reasonable
 * operator grep would run, the baseline correctly scores zero.
 */
function grepRankSessions(
  probe: DatabaseSync,
  corpus: Map<string, Array<{ role: string; content: string }>>,
  question: string,
): string[] {
  const terms = questionTerms(question);
  if (terms.length === 0) return [];

  const wordRe = /[\p{L}\p{N}]+/gu;
  const scored: Array<{ sessionId: string; hits: number }> = [];
  for (const [sessionId, messages] of corpus) {
    const text = messages.map((m) => m.content).join("\n").toLowerCase();
    const words = text.match(wordRe) ?? [];
    let hits = 0;
    for (const term of terms) {
      // Fast path first: an exact surface match is always a stem match.
      if (words.includes(term) || words.some((w) => stemsEquivalentCached(probe, term, w))) {
        hits += 1;
      }
    }
    if (hits > 0) scored.push({ sessionId, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map((s) => s.sessionId);
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

describe("recall fixtures", () => {
  const queries = loadQueries();
  const corpus = loadCorpus();

  it("every query references an existing session", () => {
    for (const q of queries) {
      expect(corpus.has(q.session_id), `${q.id} -> ${q.session_id}`).toBe(true);
    }
  });

  it("no question contains its own forbidden terms (load-bearing check)", () => {
    // A fixture whose question shares vocabulary with its document measures
    // nothing. Forbidden terms are matched on word boundaries after lower-
    // casing, and also by stem equivalence so morphological variants
    // ("reverting" ~ forbidden "revert") count as shared vocabulary.
    const probe = newStemmerProbe();
    try {
      for (const q of queries) {
        const lowered = q.question.toLowerCase();
        const questionWords = lowered.match(/[\p{L}\p{N}]+/gu) ?? [];
        for (const term of q.forbidden_terms) {
          const t = term.toLowerCase();
          const boundaryRe = new RegExp(
            `(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`,
            "u",
          );
          expect(
            boundaryRe.test(lowered),
            `${q.id}: question contains forbidden term "${term}"`,
          ).toBe(false);
          // Stem-level check: "reverting" must not slip past forbidden "revert".
          for (const word of questionWords) {
            expect(
              stemsEquivalent(probe, t, word),
              `${q.id}: question word "${word}" is a morphological variant of forbidden term "${term}"`,
            ).toBe(false);
          }
        }
      }
    } finally {
      probe.close();
    }
  });

  describe("recall gate (runs the same /search episodic path as the daemon)", () => {
    let db: DatabaseSync;
    let stemmer: DatabaseSync;
    // Seed: one conversation + leaf summary per fixture session.
    const sessionIdByConversationId = new Map<number, string>();

    beforeAll(async () => {
      db = new DatabaseSync(":memory:");
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);

      for (const [sessionId, messages] of corpus) {
        const conv = await convStore.createConversation({ sessionId });
        sessionIdByConversationId.set(conv.conversationId, sessionId);
        const inputs = messages.map((m, i) => ({
          conversationId: conv.conversationId,
          seq: i,
          role: m.role as "user" | "assistant",
          content: m.content,
          tokenCount: Math.max(1, Math.ceil(m.content.length / 4)),
        }));
        const created = await convStore.createMessagesBulk(inputs);
        const summary = await summStore.insertSummary({
          summaryId: `sum_${sessionId}`,
          conversationId: conv.conversationId,
          kind: "leaf",
          content: messages.map((m) => m.content).join("\n"),
          tokenCount: inputs.reduce((acc, i) => acc + i.tokenCount, 0),
        });
        await summStore.linkSummaryToMessages(
          summary.summaryId,
          created.map((m) => m.messageId),
        );
      }

      // Stemmer probe used only to mirror porter stemming for the grep baseline.
      stemmer = newStemmerProbe();
    });

    afterAll(() => {
      db?.close();
      stemmer?.close();
    });

    async function searchSessionRanking(question: string): Promise<string[]> {
      const engine = new RetrievalEngine(
        new ConversationStore(db),
        new SummaryStore(db),
      );
      const result = await engine.grep({ query: question, mode: "full_text", scope: "both" });
      const all = [...result.messages, ...result.summaries];
      const ranking: string[] = [];
      const seen = new Set<string>();
      for (const match of all) {
        const sessionId = sessionIdByConversationId.get(match.conversationId);
        if (sessionId && !seen.has(sessionId)) {
          seen.add(sessionId);
          ranking.push(sessionId);
        }
      }
      return ranking;
    }

    function termInSession(sessionId: string, term: string): boolean {
      const row = db
        .prepare(
          `SELECT 1 AS hit FROM messages WHERE conversation_id = ? AND content LIKE ? LIMIT 1`,
        )
        .get(sessionConversationId(sessionId), `%${term}%`) as { hit: number } | undefined;
      return row !== undefined;
    }

    function sessionConversationId(sessionId: string): number {
      for (const [convId, sid] of sessionIdByConversationId) {
        if (sid === sessionId) return convId;
      }
      throw new Error(`unknown session ${sessionId}`);
    }

    it("meets the CI gate: recall@5, beats grep, low empty rate, fast", { timeout: 15000 }, async () => {
      let searchHits = 0;
      let grepHits = 0;
      let emptyResults = 0;
      const latencies: number[] = [];
      const misses: string[] = [];

      for (const q of queries) {
        const start = performance.now();
        const ranking = await searchSessionRanking(q.question);
        latencies.push(performance.now() - start);

        if (ranking.length === 0) emptyResults += 1;
        const searchHit = ranking.some(
          (sid, i) =>
            i < RECALL_K &&
            (sid === q.session_id ||
              // A result whose session actually contains the query term is a
              // legitimate lexical hit (small corpora repeat vocabulary);
              // treating it as a wrong answer would understate both systems.
              questionTerms(q.question).some((t) => termInSession(sid, t))),
        );
        if (searchHit) {
          searchHits += 1;
        } else {
          misses.push(`${q.id}: "${q.question}" -> [${ranking.join(", ")}]`);
        }

        const grepRanking = grepRankSessions(stemmer, corpus, q.question);
        if (grepRanking.slice(0, RECALL_K).includes(q.session_id)) {
          grepHits += 1;
        }
      }

      const searchRecall = searchHits / queries.length;
      const grepRecall = grepHits / queries.length;
      const emptyRate = emptyResults / queries.length;
      const p95 = percentile95(latencies);

      console.log(
        `[recall] search=${searchHits}/${queries.length} (recall@5=${searchRecall.toFixed(2)}) ` +
          `grep=${grepHits}/${queries.length} (recall@5=${grepRecall.toFixed(2)}) ` +
          `empty=${(emptyRate * 100).toFixed(0)}% p95=${p95.toFixed(1)}ms`,
      );
      if (misses.length > 0) {
        console.log(`[recall] misses:\n  ${misses.join("\n  ")}`);
      }

      // The gate from issue #309 — thresholds ratchet upward, never down.
      expect(
        searchRecall,
        `recall@5 ${searchRecall.toFixed(2)} below threshold ${RECALL_THRESHOLD}`,
      ).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
      expect(
        searchRecall,
        `search recall@5 (${searchRecall.toFixed(2)}) must strictly beat the grep baseline (${grepRecall.toFixed(2)})`,
      ).toBeGreaterThan(grepRecall);
      expect(
        emptyRate,
        `empty-result rate ${(emptyRate * 100).toFixed(0)}% above ${EMPTY_RATE_THRESHOLD * 100}%`,
      ).toBeLessThanOrEqual(EMPTY_RATE_THRESHOLD);
      expect(
        p95,
        `p95 query latency ${p95.toFixed(1)}ms above ${P95_LATENCY_MS}ms`,
      ).toBeLessThanOrEqual(P95_LATENCY_MS);
    });

    it("single-keyword lookups still work (issue's control queries)", async () => {
      const engine = new RetrievalEngine(
        new ConversationStore(db),
        new SummaryStore(db),
      );
      for (const keyword of ["rollback", "merge", "sqlite", "exif"]) {
        const result = await engine.grep({ query: keyword, mode: "full_text", scope: "both" });
        expect(
          result.messages.length + result.summaries.length,
          `keyword "${keyword}" returned no results`,
        ).toBeGreaterThan(0);
      }
    });

    it("punctuated phrases still match exactly", async () => {
      const engine = new RetrievalEngine(
        new ConversationStore(db),
        new SummaryStore(db),
      );
      const result = await engine.grep({
        query: "merge-train",
        mode: "full_text",
        scope: "both",
      });
      const sessionIds = new Set(
        [...result.messages, ...result.summaries].map((m) =>
          sessionIdByConversationId.get(m.conversationId),
        ),
      );
      expect(sessionIds.has("007-merge-train-stall")).toBe(true);
    });
  });
});
