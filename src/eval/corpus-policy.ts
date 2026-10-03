import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectDir, projectId, realpathDeep } from "../daemon/project.js";
import { projectMetaPathIn, readProjectMetaIn } from "../daemon/project-meta.js";
import type { LcmPaths } from "../lcm-paths.js";

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

/**
 * Case is ignored: macOS and Windows file systems usually ignore it, and a cwd
 * recorded in another casing must not slip past. On a case-sensitive file system
 * this can only exclude more, never less.
 */
export function isExcluded(cwd: string, exclusion: Exclusion): boolean {
  const forms = [resolve(cwd), realpathDeep(resolve(cwd))].map(form => form.toLowerCase());
  return forms.some(form =>
    exclusion.under.some(root => within(form, root.toLowerCase())) ||
    exclusion.containing.some(name => form.includes(name.toLowerCase())));
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The cwd every ingested project's meta.json records. Opens no database. */
function ingestedCwds(lcmPaths: LcmPaths): string[] {
  if (!existsSync(lcmPaths.projectsDir)) return [];
  return readdirSync(lcmPaths.projectsDir).flatMap(entry => readMetaCwd(projectMetaPathIn(join(lcmPaths.projectsDir, entry))) ?? []);
}

/** Corpus discovery skips entries whose metadata is absent, invalid or unreadable. */
export function readMetaCwd(meta: string): string | undefined {
  try {
    return readProjectMetaIn(dirname(meta))?.cwd;
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

export function readCorpusConfig(file: string, lcmPaths: LcmPaths, options: { required?: boolean; candidateCwds?: readonly string[] } = {}): CorpusConfig {
  const config = readConfigObject(file);
  if (!config && options.required) throw new Error("An explicit bench-corpora.json policy is required for evaluation.");
  if (!config) return { holdout: new Set(), exclude: { under: [], containing: [] } };
  const list =(key: (typeof CONFIG_KEYS)[number], valid: (entry: string) => boolean, shape: string): string[] => {
    const value = Object.hasOwn(config, key) ? config[key] : [];
    if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && valid(entry))) {
      throw new Error(`${file}: "${key}" must be a list of ${shape}.`);
    }
    return value;
  };
  let cwds: string[] | undefined;
  const ingested = () => (cwds ??= [...ingestedCwds(lcmPaths), ...(options.candidateCwds ?? [])]);
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
