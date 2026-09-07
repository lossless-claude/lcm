import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath, projectId } from "./daemon/project.js";
import { runLcmMigrations } from "./db/migration.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { PromotedStore } from "./db/promoted.js";
import { RetrievalEngine } from "./retrieval.js";
import { extractQueryTerms } from "./store/fts5-query.js";

/**
 * Layer 2 recall benchmark (issue #309): build and run a natural-language
 * recall benchmark from the user's own ingested sessions — the only corpus
 * with realistic noise. Benchmark files are written next to the project DB
 * (under ~/.lossless-claude) and never touch the repository.
 *
 * Ground truth: `build` samples sessions and extracts a distinctive user
 * prompt from each. The question is a paraphrase that avoids the prompt's
 * own content words — by the configured summarizer when available, or by a
 * deterministic mechanical fallback (wh-question template + capitals, which
 * share almost no vocabulary with the prompt). The source session is the
 * answer.
 */

export type BenchQuery = {
  id: string;
  sessionId: string;
  prompt: string;
  question: string;
  generator: "mechanical" | "llm";
};

export type BenchFile = {
  version: 1;
  cwd: string;
  generatedAt: string;
  generator: string;
  queries: BenchQuery[];
};

export type BenchOptions = {
  cwd: string;
  n?: number;
  k?: number;
  out?: string;
  benchFile?: string;
  seed?: number;
  json?: boolean;
};

export type BenchResult = {
  out: string;
  exitCode: number;
  stdout: string;
};

const DEFAULT_BENCH_FILENAME = ".lcm-bench.json";
const DEFAULT_RESULTS_FILENAME = ".lcm-bench-results.json";

function benchPath(cwd: string, override?: string, fallback = DEFAULT_BENCH_FILENAME): string {
  if (override) return override;
  const dbPath = projectDbPath(cwd);
  return join(dirname(dbPath), fallback);
}

// ── build ────────────────────────────────────────────────────────────────────

/** Mulberry32 — small deterministic PRNG so benchmarks are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * True when the prompt looks like a real instruction rather than noise:
 * slash commands, tool output pastes, XML-ish system blocks, and empty
 * shells are excluded.
 */
function isDistinctivePrompt(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 40 || trimmed.length > 1200) return false;
  if (trimmed.startsWith("<") || trimmed.startsWith("/")) return false;
  if (/^\s*[{[]/.test(trimmed)) return false;
  if (/caveat: the messages below were generated/i.test(trimmed)) return false;
  if (/^\s*\[?\s*(tool|function)[_\s-]?(call|result|output)/i.test(trimmed)) return false;
  // Must contain at least one content word that survives stopword removal.
  return extractQueryTerms(trimmed).length >= 2;
}

const MECHANICAL_TEMPLATES: Array<(focus: string) => string> = [
  (focus) => `what did we work on around ${focus}?`,
  (focus) => `what did we decide about ${focus}?`,
  (focus) => `how did we fix the ${focus} problem?`,
  (focus) => `why did we change ${focus}?`,
  (focus) => `what was the issue with ${focus}?`,
];

/**
 * When a prompt has no capitalized identifiers at all (plain prose), fall
 * back to describing the *kind* of situation rather than an entity. These
 * are the "asks with everyday words" phrasings from the issue — they match
 * on the situation words that prompts reliably contain.
 */
const OUTCOME_FALLBACKS: Array<{ when: RegExp; question: string }> = [
  { when: /\b(broke|broken|fail|failed|failing|failure|crash|bug)\b/i, question: "how did we get things working again after it broke?" },
  { when: /\b(decided|decision|choose|chose|choice|pick|picked|tradeoffs)\b/i, question: "what choice did we make and what tipped the scales?" },
  { when: /\b(slow|stall|stalled|stuck|freeze|frozen|latency|performance)\b/i, question: "why was everything grinding to a halt and what fixed it?" },
  { when: /\b(deploy|release|ship|shipping|publish)\b/i, question: "how did we get the new version out to users?" },
  { when: /\b(security|auth|password|secret|token|permission)\b/i, question: "how do we keep strangers from calling our endpoints?" },
  { when: /\b(database|sqlite|postgres|storage|persist)\b/i, question: "what did we pick to store the data in?" },
  { when: /\b(test|tests|ci|pipeline|build)\b/i, question: "why did the checks keep failing and how did we stabilize them?" },
];

/**
 * Capitalized mid-sentence identifiers: CamelCase, acronyms, paths. Sentence-
 * initial words ("The", "How") and stopwords are excluded — they carry no
 * signal and make the generated question useless.
 */
function capitalizedIdentifiers(prompt: string): string[] {
  const matches = [...prompt.matchAll(/\b[A-Z][\w./-]{2,}\b/g)];
  return matches
    .filter((m) => {
      const word = m[0];
      const before = prompt.slice(0, m.index).trimEnd();
      // Exclude sentence-initial words (start of text or after . ! ?).
      if (before.length === 0 || /[.!?]\s*$/.test(before)) return false;
      // Exclude anything the query tokenizer would treat as a stopword.
      if (extractQueryTerms(word.toLowerCase()).length === 0) return false;
      return true;
    })
    .map((m) => m[0]);
}

/**
 * Deterministic vocabulary-diverging question: wh-word + a focus term that
 * shares little content vocabulary with the prompt. First choice is a
 * capitalized mid-sentence identifier (CamelCase, acronyms, paths). When the
 * prompt has none, fall back to an uppercase token anywhere in the prompt
 * (e.g. "CDN", "CI", "OAuth2"), then to an outcome description of the
 * situation so the question still asks about something real.
 */
function mechanicalQuestion(prompt: string, rand: () => number): string {
  const focus =
    pick(capitalizedIdentifiers(prompt), rand) ??
    pick(
      (prompt.match(/\b[A-Z][A-Z0-9]{1,}\b/g) ?? []).filter(
        (w) => extractQueryTerms(w.toLowerCase()).length > 0,
      ),
      rand,
    );
  if (focus) {
    const template = MECHANICAL_TEMPLATES[Math.floor(rand() * MECHANICAL_TEMPLATES.length)];
    return template(focus);
  }
  const fallback = OUTCOME_FALLBACKS.find((f) => f.when.test(prompt));
  return fallback?.question ?? "what did we work on in that session?";
}

function pick<T>(items: T[], rand: () => number): T | undefined {
  return items.length > 0 ? items[Math.floor(rand() * items.length)] : undefined;
}

export type QuestionGenerator = (prompt: string) => Promise<string | null>;

/**
 * Build the benchmark file: sample sessions, extract a distinctive user
 * prompt from each, and produce a vocabulary-excluding question for it.
 * Pass `generateQuestion` to use the configured summarizer for paraphrasing;
 * without it, the mechanical fallback is used for every prompt.
 */
export async function buildBench(
  opts: BenchOptions,
  generateQuestion?: QuestionGenerator,
): Promise<BenchResult> {
  const n = opts.n ?? 20;
  const rand = mulberry32(opts.seed ?? 42);
  const dbPath = projectDbPath(opts.cwd);
  if (!existsSync(dbPath)) {
    return {
      out: "",
      exitCode: 1,
      stdout: `No project database found for ${opts.cwd}.\nRun \`lcm import\` (or use a project with ingested sessions) first.\n`,
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const convStore = new ConversationStore(db);
    const conversations = (await convStore.listConversations()).filter(
      (c) => c.sessionId.length > 0,
    );
    if (conversations.length === 0) {
      return { out: "", exitCode: 1, stdout: "No conversations in the project database.\n" };
    }

    // Deterministic shuffle, then walk until we have n usable prompts.
    const shuffled = [...conversations];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const queries: BenchQuery[] = [];
    let usedLlm = false;
    for (const conv of shuffled) {
      if (queries.length >= n) break;
      const messages = await convStore.getMessages(conv.conversationId);
      const candidates = messages.filter(
        (m) => m.role === "user" && isDistinctivePrompt(m.content),
      );
      if (candidates.length === 0) continue;
      const prompt = candidates[Math.floor(rand() * candidates.length)];

      let question: string | null = null;
      let generator: BenchQuery["generator"] = "mechanical";
      if (generateQuestion) {
        question = await generateQuestion(prompt.content);
        if (question) {
          generator = "llm";
          usedLlm = true;
        }
      }
      if (!question) {
        question = mechanicalQuestion(prompt.content, rand);
      }
      queries.push({
        id: String(queries.length + 1).padStart(3, "0"),
        sessionId: conv.sessionId,
        prompt: prompt.content,
        question,
        generator,
      });
    }

    if (queries.length === 0) {
      return {
        out: "",
        exitCode: 1,
        stdout: "Could not extract any distinctive user prompts from the ingested sessions.\n",
      };
    }

    const bench: BenchFile = {
      version: 1,
      cwd: opts.cwd,
      generatedAt: new Date().toISOString(),
      generator: usedLlm ? "llm+mechanical" : "mechanical",
      queries,
    };
    const out = benchPath(opts.cwd, opts.out);
    await writeFile(out, JSON.stringify(bench, null, 2));
    return {
      out,
      exitCode: 0,
      stdout: `Wrote ${queries.length} benchmark questions (${bench.generator}) to ${out}\n`,
    };
  } finally {
    db.close();
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

type QueryOutcome = {
  id: string;
  question: string;
  expectedSessionId: string;
  searchTopK: string[];
  searchHit: boolean;
  empty: boolean;
  grepHit: boolean;
  latencyMs: number;
};

/** The grep floor from the issue: OR the content terms over raw message text. */
function grepSessionIds(db: DatabaseSync, question: string): string[] {
  const terms = extractQueryTerms(question);
  if (terms.length === 0) return [];
  const like = terms.map(() => "LOWER(content) LIKE ? ESCAPE '\\'");
  const args = terms.map((t) => `%${t.replace(/([\\%_])/g, "\\$1")}%`);
  const rows = db
    .prepare(
      `SELECT c.session_id AS session_id, COUNT(*) AS hits
       FROM messages m
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE ${like.join(" OR ")}
       GROUP BY c.session_id
       ORDER BY hits DESC`,
    )
    .all(...args) as Array<{ session_id: string }>;
  return rows.map((r) => r.session_id);
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const k = opts.k ?? 5;
  const file = benchPath(opts.cwd, opts.benchFile);
  let bench: BenchFile;
  try {
    bench = JSON.parse(await readFile(file, "utf-8")) as BenchFile;
  } catch {
    return {
      out: "",
      exitCode: 1,
      stdout: `No benchmark file at ${file}.\nRun \`lcm bench build\` first.\n`,
    };
  }

  const dbPath = projectDbPath(opts.cwd);
  if (!existsSync(dbPath)) {
    return { out: "", exitCode: 1, stdout: `No project database found for ${opts.cwd}.\n` };
  }

  // Migrations may backfill on first open, so this handle is read-write.
  const db = new DatabaseSync(dbPath);
  try {
    runLcmMigrations(db);
    const convStore = new ConversationStore(db);
    const engine = new RetrievalEngine(convStore, new SummaryStore(db));
    const promotedStore = new PromotedStore(db);
    const pid = projectId(opts.cwd);

    const outcomes: QueryOutcome[] = [];
    for (const q of bench.queries) {
      const start = performance.now();
      const grepResult = await engine.grep({ query: q.question, mode: "full_text", scope: "both" });
      const promoted = promotedStore.search(q.question, k, undefined, pid);
      const latencyMs = performance.now() - start;

      const sessionIds: string[] = [];
      const seen = new Set<string>();
      for (const match of [...grepResult.messages, ...grepResult.summaries]) {
        const conv = await convStore.getConversation(match.conversationId);
        const sid = conv?.sessionId;
        if (sid && !seen.has(sid)) {
          seen.add(sid);
          sessionIds.push(sid);
        }
      }
      for (const mem of promoted) {
        if (mem.sessionId && !seen.has(mem.sessionId)) {
          seen.add(mem.sessionId);
          sessionIds.push(mem.sessionId);
        }
      }

      const empty = sessionIds.length === 0;
      const searchHit = sessionIds.slice(0, k).includes(q.sessionId);
      const grepHit = grepSessionIds(db, q.question).slice(0, k).includes(q.sessionId);
      outcomes.push({
        id: q.id,
        question: q.question,
        expectedSessionId: q.sessionId,
        searchTopK: sessionIds.slice(0, k),
        searchHit,
        empty,
        grepHit,
        latencyMs,
      });
    }

    const total = outcomes.length;
    const searchHits = outcomes.filter((o) => o.searchHit).length;
    const grepHits = outcomes.filter((o) => o.grepHit).length;
    const emptyCount = outcomes.filter((o) => o.empty).length;
    const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
    const searchRecall = searchHits / total;
    const grepRecall = grepHits / total;

    const report = {
      file,
      total,
      k,
      searchRecall,
      grepRecall,
      emptyRate: emptyCount / total,
      p95LatencyMs: Math.round(p95 * 10) / 10,
      misses: outcomes
        .filter((o) => !o.searchHit)
        .map((o) => ({ id: o.id, question: o.question, expected: o.expectedSessionId, got: o.searchTopK })),
    };

    const resultsPath = join(dirname(dbPath), DEFAULT_RESULTS_FILENAME);
    await writeFile(resultsPath, JSON.stringify({ report, outcomes }, null, 2));

    if (opts.json) {
      return { out: resultsPath, exitCode: 0, stdout: JSON.stringify(report, null, 2) + "\n" };
    }

    const lines = [
      "",
      `  recall@${k}  search ${searchHits}/${total} (${(searchRecall * 100).toFixed(0)}%)  vs  grep ${grepHits}/${total} (${(grepRecall * 100).toFixed(0)}%)`,
      `  empty results  ${emptyCount}/${total} (${((emptyCount / total) * 100).toFixed(0)}%)`,
      `  p95 latency    ${report.p95LatencyMs}ms`,
      "",
    ];
    if (report.misses.length > 0) {
      lines.push("  misses:");
      for (const m of report.misses) {
        lines.push(`    ${m.id}  "${m.question}"  (wanted ${m.expected})`);
      }
      lines.push("");
    }
    lines.push(`  full results written to ${resultsPath}`, "");
    return { out: resultsPath, exitCode: 0, stdout: lines.join("\n") };
  } finally {
    db.close();
  }
}
