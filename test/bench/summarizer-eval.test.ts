import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LcmSummarizeFn } from "../../src/llm/types.js";
import {
  buildSyntheticSession,
  loadCorpusDir,
  runEval,
  scoreSummary,
  writeResult,
  type CorpusSession,
} from "./summarizer-eval-harness.js";
import { createEvalSummarizer, type EvalProvider } from "./summarizer-eval-providers.js";

const RESULTS_DIR = join(import.meta.dirname, "results");

/** Offline stand-in that obeys the prompt contract and echoes the input head. */
const fakeSummarizer: LcmSummarizeFn = async (text, _aggressive, ctx = {}) => {
  const head = text.replace(/\[[^\]]*\]\n/g, "").slice(0, 2400);
  const files = ctx.isCondensed ? "" : "Files: none\n";
  return `${files}${head}\nExpand for details about: filler observations`;
};

describe("summarizer eval harness (offline)", () => {
  it("runs leaf and depth-1 passes under production config and scores them", async () => {
    const session = buildSyntheticSession();
    const result = await runEval({ session, summarizer: fakeSummarizer, model: "fake", run: 1 });

    expect(result.incomplete).toBe(false);
    expect(result.calls.filter((c) => c.pass === "leaf").length).toBeGreaterThanOrEqual(3);
    expect(result.calls.filter((c) => c.pass === "condensed" && c.depth === 1).length).toBeGreaterThanOrEqual(1);
    expect(result.summaries.some((s) => s.depth === 1)).toBe(true);
    expect(result.totals.formatTotal).toBe(result.calls.length);
    expect(result.totals.formatPass).toBe(result.totals.formatTotal);
    expect(result.plantedFacts?.map((f) => f.name)).toHaveLength(5);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  }, 30_000);

  it("scores format per pass type", () => {
    const leaf = scoreSummary("Did things.\nFiles: none\nExpand for details about: x", 0);
    expect(leaf).toMatchObject({ hasFilesLine: true, hasExpandTrailer: true, isFallback: false });
    const condensed = scoreSummary("Did things.\nExpand for details about: x", 1);
    expect(condensed).toMatchObject({ hasFilesLine: null, hasExpandTrailer: true });
    expect(scoreSummary("Did things.", 0)).toMatchObject({ hasFilesLine: false, hasExpandTrailer: false });
    expect(scoreSummary("raw text\n[Truncated from 900 tokens]", 0).isFallback).toBe(true);
  });

  it("marks a run incomplete when the summarizer keeps failing", async () => {
    const failing: LcmSummarizeFn = async () => {
      throw new Error("429 rate limited");
    };
    const result = await runEval({ session: buildSyntheticSession(), summarizer: failing, model: "fake", run: 1 });
    expect(result.incomplete).toBe(true);
    expect(result.error).toContain("429");
    expect(result.totals.failedCalls).toBe(1);
  }, 30_000);
});

// ── Live eval, gated by env ────────────────────────────────────────────────
//
//   LCM_EVAL_MODEL       candidate model id (required)
//   LCM_EVAL_CORPUS_DIR  directory of <label>.json exports (required)
//   LCM_EVAL_PROVIDER    openrouter (default) | openai | claude-process
//   LCM_EVAL_BASE_URL    openai only: OpenAI-compatible endpoint; LCM_EVAL_API_KEY optional
//   LCM_EVAL_RUNS        runs per session (default 1)
//   LCM_EVAL_SESSIONS    comma-separated labels to run (default all)
//   LCM_EVAL_REASONING         http providers: JSON sent as `reasoning`, e.g. {"enabled":false} (default none)
//   LCM_EVAL_REASONING_EFFORT  shorthand for LCM_EVAL_REASONING={"effort":"<value>"}
//   LCM_EVAL_DISABLE_THINKING  http providers: "1" sends chat_template_kwargs.enable_thinking=false (Qwen-style servers)

const EVAL_PROVIDERS: readonly EvalProvider[] = ["openrouter", "openai", "claude-process"];

function parseProvider(value: string | undefined): EvalProvider {
  if (value === undefined) return "openrouter";
  if ((EVAL_PROVIDERS as readonly string[]).includes(value)) return value as EvalProvider;
  throw new Error(`LCM_EVAL_PROVIDER must be one of ${EVAL_PROVIDERS.join(", ")}, got: ${value}`);
}

function parseRuns(value: string | undefined): number {
  if (value === undefined) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`LCM_EVAL_RUNS must be a positive integer, got: ${value}`);
  }
  return n;
}

const model = process.env.LCM_EVAL_MODEL;
const corpusDir = process.env.LCM_EVAL_CORPUS_DIR;
const provider = parseProvider(process.env.LCM_EVAL_PROVIDER);
const runs = parseRuns(process.env.LCM_EVAL_RUNS);
const only = process.env.LCM_EVAL_SESSIONS?.split(",").map((s) => s.trim()).filter(Boolean);

const reasoning =
  (process.env.LCM_EVAL_REASONING ? ` reasoning=${process.env.LCM_EVAL_REASONING}` : "") +
  (process.env.LCM_EVAL_REASONING_EFFORT ? ` reasoning=${process.env.LCM_EVAL_REASONING_EFFORT}` : "") +
  (process.env.LCM_EVAL_DISABLE_THINKING === "1" ? " thinking=off" : "");

describe.skipIf(!model || !corpusDir)(`summarizer eval: ${model} via ${provider}${reasoning}`, () => {
  const sessions: CorpusSession[] = (corpusDir && existsSync(corpusDir)
    ? [...loadCorpusDir(corpusDir), buildSyntheticSession()]
    : []
  ).filter((s) => !only || only.includes(s.label));

  it("has a corpus to run", () => {
    expect(sessions.length).toBeGreaterThan(0);
  });

  for (const session of sessions) {
    for (let run = 1; run <= runs; run++) {
      it(`${session.label} run ${run}`, async () => {
        const summarizer = createEvalSummarizer(provider, model!);
        const result = await runEval({ session, summarizer, model: model!, run });
        const file = writeResult(RESULTS_DIR, result);
        const facts = result.plantedFacts
          ? ` facts=${result.plantedFacts.filter((f) => f.survived).length}/${result.plantedFacts.length}`
          : "";
        console.log(
          `${session.label} run ${run}: calls=${result.totals.calls} failed=${result.totals.failedCalls}` +
            ` format=${result.totals.formatPass}/${result.totals.formatTotal} maxTokensHits=${result.totals.maxTokensHits}` +
            ` tokens=${result.tokensBefore}->${result.tokensAfter} latency=${result.totals.latencyMs}ms` +
            `${facts}${result.incomplete ? " INCOMPLETE" : ""} -> ${file}`,
        );
        // A failed or partial run is recorded, not asserted: the JSON is the deliverable.
        expect(existsSync(file)).toBe(true);
      }, 0);
    }
  }
});
