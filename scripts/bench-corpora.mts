/**
 * Run `lcm bench` across several local project corpora and pool the result.
 *
 * A single benchmark cannot tell a ranking improvement from noise. Measured on
 * one 13-question set, adding query-term coverage to session fusion read as a
 * clean +2; pooled over 221 questions from eight corpora the same change was
 * +1, and enlarging the candidate pool — which looked principled — came out
 * negative and pushed p95 past the latency budget. Neither would have been
 * caught by one corpus, so a change to retrieval ranking is measured here.
 *
 * Scores are diagnostic. Mechanically generated questions are not release
 * evidence; what this harness is for is the *direction* of a change, and
 * whether one corpus disagrees with another.
 *
 *   npx tsx scripts/bench-corpora.mts build     # (re)generate the question sets
 *   npx tsx scripts/bench-corpora.mts run       # score every corpus, print the pool
 *
 * Corpora come from `LCM_BENCH_CORPORA` (`:` separated, `;` on Windows), or
 * from every ingested project whose database is large enough to hold one.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildBench, runBench } from "../src/bench.js";
import { projectDbPath } from "../src/daemon/project.js";

const VALIDATION_FILENAME = ".lcm-bench-validation.json";

/**
 * Corpora reserved for the held-out grade, named by directory.
 *
 * A parameter chosen on the same questions that report the score is fitted, not
 * measured — the score stops being evidence. So the corpora split in two, once,
 * and stay split: a candidate is tuned against everything outside this list and
 * graded exactly once against everything inside it.
 *
 * The split is by corpus rather than by question, so no session appears on both
 * sides. The `lcm` corpus is deliberately on the tuning side: its questions have
 * already been scored across a parameter sweep and cannot serve as unseen.
 */
const HELD_OUT_CORPORA = new Set([".claude", "Inspector", "trilha-probatoria", "xgh"]);

type Group = "tune" | "holdout" | "all";

function group(): Group {
  const requested = process.env.LCM_BENCH_GROUP ?? "all";
  if (requested === "tune" || requested === "holdout") return requested;
  return "all";
}

function inGroup(cwd: string, selected: Group): boolean {
  if (selected === "all") return true;
  const held = HELD_OUT_CORPORA.has(basename(cwd));
  return selected === "holdout" ? held : !held;
}
const QUESTIONS_PER_CORPUS = Number(process.env.LCM_BENCH_N ?? 30);
/**
 * Fixed so a rerun scores the same questions, and two runs are comparable.
 * `LCM_BENCH_SEED` draws a different sample from the same corpus — use it when
 * a set has to be unseen, not when comparing two runs.
 */
const SEED = Number(process.env.LCM_BENCH_SEED ?? 1234);
/** Below this a project holds too few sessions to rank anything meaningfully. */
const MIN_DB_BYTES = 8 * 1024 * 1024;

async function discoverCorpora(): Promise<string[]> {
  const configured = process.env.LCM_BENCH_CORPORA;
  if (configured) return configured.split(delimiter).filter(Boolean);

  const root = join(homedir(), ".lossless-claude", "projects");
  if (!existsSync(root)) return [];
  const found: Array<{ cwd: string; size: number }> = [];
  for (const entry of await readdir(root)) {
    const db = join(root, entry, "db.sqlite");
    const meta = join(root, entry, "meta.json");
    if (!existsSync(db) || !existsSync(meta)) continue;
    let size: number;
    try {
      size = statSync(db).size;
    } catch {
      continue;
    }
    if (size < MIN_DB_BYTES) continue;
    try {
      const cwd = (JSON.parse(readFileSync(meta, "utf-8")) as { cwd?: string }).cwd;
      if (cwd && existsSync(projectDbPath(cwd))) found.push({ cwd, size });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => b.size - a.size).map(entry => entry.cwd);
}

function validationFile(cwd: string): string {
  return join(dirname(projectDbPath(cwd)), VALIDATION_FILENAME);
}

/**
 * Sessions held at the moment of the run. Two runs compared across a gap are
 * only comparable if this matches: a live corpus grows between them, and a
 * ranking delta measured over different content is not a delta at all.
 */
function sessionCount(cwd: string): number {
  try {
    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM conversations WHERE session_id IS NOT NULL AND session_id != ''").get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

function label(cwd: string): string {
  return (basename(cwd) || cwd).slice(0, 22).padEnd(22);
}

async function build(corpora: string[]): Promise<void> {
  for (const cwd of corpora) {
    const result = await buildBench({ cwd, n: QUESTIONS_PER_CORPUS, seed: SEED, out: validationFile(cwd) });
    console.log(`${label(cwd)} ${result.exitCode === 0 ? result.stdout.split("\n")[0] : `skipped: ${result.stdout.split("\n")[0]}`}`);
  }
}

async function run(corpora: string[]): Promise<void> {
  let hits = 0;
  let total = 0;
  let beatsGrep = 0;
  let scored = 0;
  for (const cwd of corpora) {
    const file = validationFile(cwd);
    if (!existsSync(file)) {
      console.log(`${label(cwd)} no question set — run \`build\` first`);
      continue;
    }
    const result = await runBench({ cwd, benchFile: file, k: 5, json: true });
    if (result.exitCode !== 0) {
      console.log(`${label(cwd)} skipped: ${result.stdout.split("\n")[0]}`);
      continue;
    }
    const report = JSON.parse(result.stdout) as {
      total: number; searchHitRate: number; grepHitRate: number; emptyRate: number; p95LatencyMs: number;
    };
    hits += Math.round(report.searchHitRate * report.total);
    total += report.total;
    scored++;
    if (report.searchHitRate > report.grepHitRate) beatsGrep++;
    console.log(
      `${label(cwd)} n=${String(report.total).padStart(3)}  sessions=${String(sessionCount(cwd)).padStart(4)}` +
      `  search=${report.searchHitRate.toFixed(3)}  grep=${report.grepHitRate.toFixed(3)}` +
      `  empty=${report.emptyRate.toFixed(2)}  p95=${report.p95LatencyMs}ms`,
    );
  }
  if (total === 0) {
    console.log("\nNothing scored. Run `build` first, or point LCM_BENCH_CORPORA at a project with ingested sessions.");
    return;
  }
  console.log(`\npooled  ${hits}/${total} = ${(hits / total).toFixed(3)}   beats grep on ${beatsGrep}/${scored} corpora`);
}

const command = process.argv[2] ?? "run";
const selected = group();
const corpora = (await discoverCorpora()).filter(cwd => inGroup(cwd, selected));
if (selected !== "all") console.log(`group: ${selected} (${corpora.length} corpora)\n`);
if (corpora.length === 0) {
  console.log(`No corpora found. Set LCM_BENCH_CORPORA to a "${delimiter}" separated list of project paths.`);
} else if (command === "build") {
  await build(corpora);
} else if (command === "run") {
  await run(corpora);
} else {
  console.log(`Unknown command "${command}". Use \`build\` or \`run\`.`);
}
