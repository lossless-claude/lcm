/**
 * Summarizer model eval harness.
 *
 * Runs the real CompactionEngine with the production configuration against a
 * session loaded into an in-memory SQLite database, records every summarizer
 * call, and scores the resulting summaries mechanically. No production state
 * is touched: the candidate model comes from the caller, never from
 * ~/.lossless-claude/config.json.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CompactionEngine } from "../../src/compaction.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "../../src/llm/types.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { resolveMaxOutputTokens, resolveTargetTokens } from "../../src/summarize.js";

// ── Corpus ─────────────────────────────────────────────────────────────────

/** Same estimate production uses for prompt sizing. */
const CHARS_PER_TOKEN = 4;

export type CorpusMessage = {
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  tokenCount: number;
  createdAt: string;
};

export type PlantedFact = { name: string; pattern: string };

export type CorpusSession = {
  label: string;
  messages: CorpusMessage[];
  plantedFacts?: PlantedFact[];
};

/** Load every `<label>.json` in a directory; each file is a `CorpusMessage[]`. */
export function loadCorpusDir(dir: string): CorpusSession[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      label: basename(f, ".json"),
      messages: JSON.parse(readFileSync(join(dir, f), "utf-8")) as CorpusMessage[],
    }));
}

// ── Synthetic session with planted facts ──────────────────────────────────

const PLANTED_FACTS: PlantedFact[] = [
  { name: "decision-with-rationale", pattern: "ristretto|allocator" },
  { name: "renamed-file", pattern: "ledger-writer\\.ts" },
  { name: "open-task", pattern: "backfill|verticality" },
  { name: "numeric-constraint", pattern: "7331" },
  { name: "user-correction", pattern: "ULID" },
];

const FILLER_TOPICS = [
  "the retry policy for the ingest queue",
  "the shape of the config loader",
  "how the daemon reports health",
  "the CLI help text layout",
  "the migration ordering rules",
  "the search index rebuild path",
  "the log rotation cadence",
  "the plugin manifest validation",
];

function fillerTurn(i: number): [string, string] {
  const topic = FILLER_TOPICS[i % FILLER_TOPICS.length];
  const user = `Let's look at ${topic}. Walk me through the current behaviour and any edge cases you see, turn ${i}.`;
  const lines: string[] = [];
  for (let j = 0; j < 40; j++) {
    lines.push(
      `Observation ${i}.${j}: ${topic} handles case ${j} by checking the input, ` +
        `normalising it, and writing the outcome to the store before returning. ` +
        `No branch here changes public behaviour; the code path is covered by unit tests.`,
    );
  }
  return [user, lines.join("\n")];
}

/**
 * A synthetic session large enough for three leaf chunks under production
 * config; a depth-1 condensation follows only when the leaf summaries are
 * verbose enough to reach the condensed minimum. The five facts are planted in
 * the first turns so they sit outside the protected fresh tail and must
 * survive summarization to appear in the final context.
 */
export function buildSyntheticSession(): CorpusSession {
  const planted: [string, string][] = [
    [
      "Which cache library should we use for the summary lookups?",
      "Decision: use ristretto for the cache. Rationale: the allocator pressure of the LRU alternative was 3x higher in the profile.",
    ],
    [
      "Rename the writer module so its name matches what it does.",
      "Done. Renamed src/ledger/writer.ts to src/ledger/ledger-writer.ts and updated the three imports.",
    ],
    [
      "What is still open after this?",
      "Open task: backfill the verticality column for records imported before March. Not started.",
    ],
    [
      "How many rows can one batch carry?",
      "The numeric constraint is hard: a batch may carry at most 7331 rows, enforced by the schema check.",
    ],
    [
      "You wrote UUID above. That is wrong, we use ULID for record ids.",
      "Correct, my mistake. Record ids are ULID, not UUID. I updated the note.",
    ],
  ];

  const messages: CorpusMessage[] = [];
  const base = Date.parse("2026-01-01T00:00:00Z");
  let seq = 0;
  const push = (role: CorpusMessage["role"], content: string) => {
    messages.push({
      seq: seq++,
      role,
      content,
      tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      createdAt: new Date(base + seq * 60_000).toISOString(),
    });
  };

  for (const [u, a] of planted) {
    push("user", u);
    push("assistant", a);
  }
  // ~73k tokens of filler: three 20k leaf chunks outside the tail, then one condensation.
  for (let i = 0; i < 30; i++) {
    const [u, a] = fillerTurn(i);
    push("user", u);
    push("assistant", a);
  }

  return { label: "synthetic-planted", messages, plantedFacts: PLANTED_FACTS };
}

// ── Instrumented summarizer ────────────────────────────────────────────────

/** Production usage shape with the provider label widened to bench providers. */
export type EvalUsage = Omit<SummarizerUsage, "provider"> & { provider: string };

export type SummarizerCall = {
  pass: "leaf" | "condensed";
  depth: number;
  aggressive: boolean;
  inputChars: number;
  targetTokens: number;
  outputChars: number;
  outputTokensEstimate: number;
  latencyMs: number;
  output?: string;
  /** Format checks on this call's output; leaf summaries get condensed away and would otherwise go unscored. */
  format?: SummaryScore;
  usage?: EvalUsage;
  /** openai.ts returns the input prefix when the model sends empty content. */
  emptyContentFallback: boolean;
  error?: string;
};

export type InstrumentedSummarizer = { summarize: LcmSummarizeFn; calls: SummarizerCall[] };

/** Wrap a summarizer so every call is recorded with the same target the summarizer computed. */
export function instrumentSummarizer(inner: LcmSummarizeFn): InstrumentedSummarizer {
  const calls: SummarizerCall[] = [];
  const summarize: LcmSummarizeFn = async (text, aggressive, ctx: SummarizeContext = {}) => {
    const isCondensed = ctx.isCondensed ?? false;
    const targetTokens =
      ctx.targetTokens ??
      resolveTargetTokens({
        inputTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
        mode: aggressive ? "aggressive" : "normal",
        isCondensed,
        condensedTargetTokens: 2000,
      });
    const call: SummarizerCall = {
      pass: isCondensed ? "condensed" : "leaf",
      depth: isCondensed ? (ctx.depth ?? 1) : 0,
      aggressive: aggressive === true,
      inputChars: text.length,
      targetTokens,
      outputChars: 0,
      outputTokensEstimate: 0,
      latencyMs: 0,
      emptyContentFallback: false,
    };
    calls.push(call);
    const started = Date.now();
    try {
      const out = await inner(text, aggressive, {
        ...ctx,
        onUsage: (usage) => {
          call.usage = usage;
          ctx.onUsage?.(usage);
        },
      });
      call.latencyMs = Date.now() - started;
      call.outputChars = out.length;
      call.outputTokensEstimate = Math.ceil(out.length / CHARS_PER_TOKEN);
      call.output = out;
      call.format = scoreSummary(out, call.depth);
      call.emptyContentFallback = out === text.slice(0, 500);
      return out;
    } catch (err) {
      call.latencyMs = Date.now() - started;
      call.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };
  return { summarize, calls };
}

// ── Scoring ────────────────────────────────────────────────────────────────

export type SummaryScore = {
  depth: number;
  chars: number;
  tokensEstimate: number;
  hasFilesLine: boolean | null;
  hasExpandTrailer: boolean;
  isFallback: boolean;
};

const EXPAND_TRAILER = "Expand for details about:";

/**
 * Format checks mirror the prompt contracts: leaf prompts require a `Files:`
 * line, every prompt requires the `Expand for details about:` trailer as the
 * last line. Leaf `hasFilesLine` is null for condensed summaries.
 */
export function scoreSummary(content: string, depth: number): SummaryScore {
  const trimmed = content.trim();
  const lastLine = trimmed.split("\n").at(-1) ?? "";
  return {
    depth,
    chars: trimmed.length,
    tokensEstimate: Math.ceil(trimmed.length / CHARS_PER_TOKEN),
    hasFilesLine: depth === 0 ? /^Files:/m.test(trimmed) : null,
    hasExpandTrailer: lastLine.startsWith(EXPAND_TRAILER),
    isFallback: /\[Truncated from \d+ tokens\]$/.test(trimmed),
  };
}

export function checkPlantedFacts(
  contextText: string,
  facts: PlantedFact[],
): { name: string; survived: boolean }[] {
  return facts.map((f) => ({ name: f.name, survived: new RegExp(f.pattern, "i").test(contextText) }));
}

// ── Run ────────────────────────────────────────────────────────────────────

export type EvalRunResult = {
  label: string;
  model: string;
  run: number;
  startedAt: string;
  incomplete: boolean;
  error?: string;
  inputMessages: number;
  inputTokens: number;
  tokensBefore: number;
  tokensAfter: number;
  calls: SummarizerCall[];
  summaries: (SummaryScore & { summaryId: string; content: string })[];
  plantedFacts?: { name: string; survived: boolean }[];
  totals: {
    calls: number;
    failedCalls: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** Format-passing calls over all calls that returned output. */
    formatPass: number;
    formatTotal: number;
    /** HTTP-provider calls whose output reached the production output cap: the summary was cut off. */
    maxTokensHits: number;
  };
};


/**
 * The daemon's /compact engine config, with two deliberate deviations:
 *  - leafTargetTokens is the hardcoded default (1000) rather than the live
 *    `config.compaction.leafTokens`, so a bench run is reproducible across
 *    machines regardless of the operator's local config.json.
 *  - no scrubber: stored messages were scrubbed at ingest, and the corpus
 *    export copies stored content verbatim, so there is nothing left to scrub.
 */
function prodEngineConfig() {
  return {
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafMinFanout: 3,
    condensedMinFanout: 2,
    condensedMinFanoutHard: 1,
    incrementalMaxDepth: 0,
    leafTargetTokens: 1000,
    condensedTargetTokens: 900,
    maxRounds: 10,
  };
}

export async function runEval(input: {
  session: CorpusSession;
  summarizer: LcmSummarizeFn;
  model: string;
  run: number;
}): Promise<EvalRunResult> {
  const { session, model, run } = input;
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const conversation = await conversationStore.createConversation({ sessionId: `eval-${session.label}` });
  const cid = conversation.conversationId;

  const records = await conversationStore.createMessagesBulk(
    session.messages.map((m) => ({
      conversationId: cid,
      seq: m.seq,
      role: m.role,
      content: m.content,
      tokenCount: m.tokenCount,
    })),
  );
  // Keep original timestamps so the prompt's time headers match production.
  const setCreated = db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?");
  records.forEach((r, i) => setCreated.run(session.messages[i].createdAt, r.messageId));
  await summaryStore.appendContextMessages(cid, records.map((r) => r.messageId));

  const { summarize, calls } = instrumentSummarizer(input.summarizer);
  const engine = new CompactionEngine(conversationStore, summaryStore, prodEngineConfig());
  const tokensBefore = await summaryStore.getContextTokenCount(cid);
  const startedAt = new Date().toISOString();

  let error: string | undefined;
  try {
    await engine.compact({ conversationId: cid, tokenBudget: 200_000, summarize, force: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const items = await summaryStore.getContextItems(cid);
  const summaries: EvalRunResult["summaries"] = [];
  for (const item of items) {
    if (item.itemType !== "summary" || !item.summaryId) continue;
    const record = await summaryStore.getSummary(item.summaryId);
    if (record) {
      summaries.push({ summaryId: record.summaryId, content: record.content, ...scoreSummary(record.content, record.depth) });
    }
  }
  const tokensAfter = await summaryStore.getContextTokenCount(cid);
  db.close();

  const contextText = summaries.map((summary) => summary.content).join("\n\n");
  const scoredCalls = calls.filter((c) => c.format);
  const formatPass = scoredCalls.filter((c) => c.format!.hasExpandTrailer && c.format!.hasFilesLine !== false).length;

  return {
    label: session.label,
    model,
    run,
    startedAt,
    incomplete: error !== undefined,
    error,
    inputMessages: session.messages.length,
    inputTokens: session.messages.reduce((n, m) => n + m.tokenCount, 0),
    tokensBefore,
    tokensAfter,
    calls,
    summaries,
    plantedFacts: session.plantedFacts ? checkPlantedFacts(contextText, session.plantedFacts) : undefined,
    totals: {
      calls: calls.length,
      failedCalls: calls.filter((c) => c.error).length,
      latencyMs: calls.reduce((n, c) => n + c.latencyMs, 0),
      inputTokens: calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
      costUsd: calls.reduce((n, c) => n + (c.usage?.costUsd ?? 0), 0),
      formatPass,
      formatTotal: scoredCalls.length,
      maxTokensHits: calls.filter(
        (c) => c.usage?.provider !== "claude-process" && (c.usage?.outputTokens ?? 0) >= resolveMaxOutputTokens(c.targetTokens),
      ).length,
    },
  };
}

export function writeResult(dir: string, result: EvalRunResult): string {
  mkdirSync(dir, { recursive: true });
  const safeModel = result.model.replace(/[^a-z0-9.-]+/gi, "_");
  const file = join(dir, `${safeModel}__${result.label}__run${result.run}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}
