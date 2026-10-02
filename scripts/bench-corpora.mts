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
 * Scores are diagnostic. Generated questions are not release evidence; what
 * this harness is for is the *direction* of a change, and whether one corpus
 * disagrees with another.
 *
 *   npx tsx scripts/bench-corpora.mts build     # (re)generate the question sets
 *   npx tsx scripts/bench-corpora.mts run       # score every corpus, print the pool
 *
 * Corpora come from `LCM_BENCH_CORPORA` (`:` separated, `;` on Windows), or
 * from every ingested project whose database is large enough to hold one, less
 * the projects the corpus config excludes.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildBench, runBench } from "../src/bench.js";
import { projectDbPath, projectDir, projectId, realpathDeep } from "../src/daemon/project.js";
import { lcmHome } from "../src/lcm-home.js";
import { createLcmPaths, type LcmPaths } from "../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());

const VALIDATION_FILENAME = ".lcm-bench-validation.json";

/**
 * The machine owner's corpus split, in `bench-corpora.json` under the lcm home:
 *
 *   {
 *     "holdout": ["/path/to/project"],
 *     "exclude": ["/path/to/repository"],
 *     "excludeCwdContaining": ["repository-name"]
 *   }
 *
 * It lives outside the repository, so no tracked file names a project.
 *
 * `holdout` lists the corpora reserved for the held-out grade. A parameter chosen
 * on the same questions that report the score is fitted, not measured — the score
 * stops being evidence. So the corpora split in two, once, and stay split: a
 * candidate is tuned against everything outside this list and graded exactly once
 * against everything inside it. The split is by corpus rather than by question, so
 * no session appears on both sides. This repository's own corpus belongs on the
 * tuning side: its questions have already been scored across a parameter sweep and
 * cannot serve as unseen.
 *
 * The other two keys keep a repository out of every group. One repository is many
 * lcm projects: each worktree, each subdirectory a session started in and each
 * agent scratchpad named after it has its own cwd. `exclude` covers a path and
 * everything under it, so a worktree created inside the repository later is covered
 * too. `excludeCwdContaining` covers every project whose cwd contains a name, which
 * reaches agent worktrees and scratchpads outside the tree, even once deleted. The
 * decision reads a project's meta.json cwd and never opens its database; an
 * `LCM_BENCH_CORPORA` entry that matches is dropped. Excluded beats held out.
 *
 * `holdout` entries are absolute project paths compared by project id, so two
 * checkouts that share a directory name stay apart; they stay exact so a new
 * project under a held-out path cannot move questions already tuned on into the
 * held-out grade. Every path must be absolute and exist on disk or match an ingested
 * project; every name must occur in an ingested project's cwd. Anything else (a typo,
 * a relative path, an unexpanded "~") matches no project. A missing file holds
 * nothing out and excludes nothing. A malformed file, an unknown key or an entry that
 * matches nothing stops the run: read silently, any of them would grade a project its
 * owner meant to keep out.
 */
export type CorpusConfig = { holdout: ReadonlySet<string>; exclude: Exclusion };

/** Paths whose subtrees are excluded, each in its given and canonical form, and names a cwd must not contain. */
export type Exclusion = { under: readonly string[]; containing: readonly string[] };

const CONFIG_KEYS = ["holdout", "exclude", "excludeCwdContaining"] as const;

export function isExcluded(cwd: string, exclusion: Exclusion): boolean {
  const forms = [resolve(cwd), realpathDeep(resolve(cwd))];
  return forms.some(form =>
    exclusion.under.some(root => within(form, root)) || exclusion.containing.some(name => form.includes(name)));
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The cwd every ingested project's meta.json records. Opens no database. */
function ingestedCwds(lcmPaths: LcmPaths): string[] {
  if (!existsSync(lcmPaths.projectsDir)) return [];
  return readdirSync(lcmPaths.projectsDir).flatMap(entry => readMetaCwd(join(lcmPaths.projectsDir, entry, "meta.json")) ?? []);
}

function readMetaCwd(meta: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(meta, "utf-8")) as { cwd?: string }).cwd || undefined;
  } catch {
    return undefined;
  }
}

export function corpusConfigPath(lcmPaths: LcmPaths): string {
  return join(lcmPaths.home, "bench-corpora.json");
}

/** The file's object with only known keys, or undefined when there is no file. */
function readConfigObject(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must hold a JSON object of project lists.`);
  }
  const unknown = Object.keys(parsed).filter(key => !(CONFIG_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`${file}: unknown key ${unknown.map(key => `"${key}"`).join(", ")}.`);
  return parsed as Record<string, unknown>;
}

export function readCorpusConfig(file: string, lcmPaths: LcmPaths): CorpusConfig {
  const config = readConfigObject(file);
  if (!config) return { holdout: new Set(), exclude: { under: [], containing: [] } };
  const list =(key: (typeof CONFIG_KEYS)[number], valid: (entry: string) => boolean, shape: string): string[] => {
    const value = config[key] ?? [];
    if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && valid(entry))) {
      throw new Error(`${file}: "${key}" must be a list of ${shape}.`);
    }
    return value;
  };
  let cwds: string[] | undefined;
  const ingested = () => (cwds ??= ingestedCwds(lcmPaths));
  const requireMatch = (key: string, entries: string[], matches: (entry: string) => boolean): void => {
    const unmatched = entries.filter(entry => !matches(entry));
    if (unmatched.length > 0) throw new Error(`${file}: "${key}" entry ${unmatched.join(", ")} matches no ingested project.`);
  };

  const absolute = 'absolute project paths ("~" is not expanded)';
  const holdout = list("holdout", isAbsolute, absolute);
  requireMatch("holdout", holdout, entry => existsSync(entry) || existsSync(projectDir(entry, lcmPaths)));
  const under = list("exclude", isAbsolute, absolute);
  const roots = (entry: string): Exclusion => ({ under: [resolve(entry), realpathDeep(resolve(entry))], containing: [] });
  requireMatch("exclude", under, entry => existsSync(entry) || ingested().some(cwd => isExcluded(cwd, roots(entry))));
  const containing = list("excludeCwdContaining", entry => entry.length > 0, "non-empty names");
  requireMatch("excludeCwdContaining", containing, name => ingested().some(cwd => isExcluded(cwd, { under: [], containing: [name] })));
  return {
    holdout: new Set(holdout.map(projectId)),
    exclude: { under: under.flatMap(entry => roots(entry).under), containing },
  };
}

export type Group = "tune" | "holdout" | "all";

function group(): Group {
  const requested = process.env.LCM_BENCH_GROUP ?? "all";
  if (requested === "tune" || requested === "holdout") return requested;
  return "all";
}

export function groupCorpora(corpora: string[], selected: Group, holdout: ReadonlySet<string>): string[] {
  if (selected === "all") return corpora;
  if (selected === "holdout" && holdout.size === 0) {
    throw new Error('LCM_BENCH_GROUP=holdout, but bench-corpora.json in the lcm home lists no "holdout" project.');
  }
  return corpora.filter(cwd => holdout.has(projectId(cwd)) === (selected === "holdout"));
}
/**
 * A positive integer from the environment, or the default when unset.
 *
 * Anything else stops the run: a silently coerced `NaN` seed would reach the
 * PRNG and make a "fixed seed" produce a different sample every time, which is
 * the one failure this harness must never have.
 */
function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

const QUESTIONS_PER_CORPUS = positiveInteger("LCM_BENCH_N", 30);
/**
 * Fixed so a rerun scores the same questions, and two runs are comparable.
 * `LCM_BENCH_SEED` draws a different sample from the same corpus — use it when
 * a set has to be unseen, not when comparing two runs.
 */
const SEED = positiveInteger("LCM_BENCH_SEED", 1234);
/**
 * Questions come from the configured summarizer, written in the language each
 * corpus's author asks in. Mechanical templates are English by construction,
 * so a mechanical set measures same-language paraphrase recall — a task a
 * person who writes in another language never performs. `LCM_BENCH_LANGUAGE`
 * overrides detection for every corpus in the run.
 */
const LANGUAGE = process.env.LCM_BENCH_LANGUAGE?.trim() || undefined;
/** Below this a project holds too few sessions to rank anything meaningfully. */
const MIN_DB_BYTES = 2 * 1024 * 1024;

/**
 * The corpora to score: `configured` (the `LCM_BENCH_CORPORA` list) when set,
 * otherwise every ingested project under `lcmPaths`, minus `exclude`. Exclusion
 * is decided from the cwd alone, so no excluded database is ever opened: the
 * harness opens only the databases of the cwds returned here.
 */
export async function discoverCorpora(lcmPaths: LcmPaths, exclude: Exclusion, configured?: string): Promise<string[]> {
  if (configured) {
    return configured.split(delimiter).filter(Boolean).filter(cwd => {
      if (!isExcluded(cwd, exclude)) return true;
      console.log(`${cwd}: excluded by ${corpusConfigPath(lcmPaths)}`);
      return false;
    });
  }
  const ingested = await ingestedProjects(lcmPaths);
  const kept = ingested.filter(cwd => !isExcluded(cwd, exclude));
  if (kept.length < ingested.length) {
    console.log(`${ingested.length - kept.length} project(s) excluded by ${corpusConfigPath(lcmPaths)}`);
  }
  return kept;
}

async function ingestedProjects(lcmPaths: LcmPaths): Promise<string[]> {
  const root = lcmPaths.projectsDir;
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
    const cwd = readMetaCwd(meta);
    if (cwd && existsSync(projectDbPath(cwd, lcmPaths))) found.push({ cwd, size });
  }
  return found.sort((a, b) => b.size - a.size).map(entry => entry.cwd);
}

function validationFile(cwd: string): string {
  return join(dirname(projectDbPath(cwd, paths)), VALIDATION_FILENAME);
}

/**
 * Sessions held at the moment of the run. Two runs compared across a gap are
 * only comparable if this matches: a live corpus grows between them, and a
 * ranking delta measured over different content is not a delta at all.
 */
function sessionCount(cwd: string): number {
  try {
    const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
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
    const result = await buildBench({ cwd, n: QUESTIONS_PER_CORPUS, seed: SEED, out: validationFile(cwd), generator: "llm", language: LANGUAGE });
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const command = process.argv[2] ?? "run";
  const selected = group();
  const config = readCorpusConfig(corpusConfigPath(paths), paths);
  const corpora = groupCorpora(await discoverCorpora(paths, config.exclude, process.env.LCM_BENCH_CORPORA), selected, config.holdout);
  if (selected !== "all") console.log(`group: ${selected} (${corpora.length} corpora)\n`);
  if (selected === "tune" && config.holdout.size === 0) {
    console.log(`Nothing is held out: ${corpusConfigPath(paths)} lists no "holdout" project.\n`);
  }
  if (corpora.length === 0) {
    console.log(`No corpora found. Set LCM_BENCH_CORPORA to a "${delimiter}" separated list of project paths.`);
  } else if (command === "build") {
    await build(corpora);
  } else if (command === "run") {
    await run(corpora);
  } else {
    console.log(`Unknown command "${command}". Use \`build\` or \`run\`.`);
  }
}
