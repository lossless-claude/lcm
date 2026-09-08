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
import { buildBench, runBench } from "../src/bench.js";
import { projectDbPath } from "../src/daemon/project.js";

const VALIDATION_FILENAME = ".lcm-bench-validation.json";
const QUESTIONS_PER_CORPUS = 30;
/** Fixed so a rerun scores the same questions, and two runs are comparable. */
const SEED = 1234;
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
      `${label(cwd)} n=${String(report.total).padStart(3)}  search=${report.searchHitRate.toFixed(3)}` +
      `  grep=${report.grepHitRate.toFixed(3)}  empty=${report.emptyRate.toFixed(2)}  p95=${report.p95LatencyMs}ms`,
    );
  }
  if (total === 0) {
    console.log("\nNothing scored. Run `build` first, or point LCM_BENCH_CORPORA at a project with ingested sessions.");
    return;
  }
  console.log(`\npooled  ${hits}/${total} = ${(hits / total).toFixed(3)}   beats grep on ${beatsGrep}/${scored} corpora`);
}

const command = process.argv[2] ?? "run";
const corpora = await discoverCorpora();
if (corpora.length === 0) {
  console.log(`No corpora found. Set LCM_BENCH_CORPORA to a "${delimiter}" separated list of project paths.`);
} else if (command === "build") {
  await build(corpora);
} else if (command === "run") {
  await run(corpora);
} else {
  console.log(`Unknown command "${command}". Use \`build\` or \`run\`.`);
}
