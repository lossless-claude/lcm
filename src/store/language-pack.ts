import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import { renderTemplate } from "../prompts/loader.js";
import type { LcmSummarizeFn } from "../llm/types.js";

/**
 * A language pack is what search knows about one language: today, its
 * function words. The English list ships in code; every other language gets
 * a pack generated once by the configured model the first time a corpus in
 * that language is seen, written next to the project databases and reused
 * from then on. Packs are plain JSON, reviewable and hand-editable; deleting
 * one makes the next detection regenerate it.
 */
export type LanguagePack = {
  version: 1;
  tag: string;
  stopwords: string[];
  generatedBy?: string;
  generatedAt: string;
};

const TERM_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const MIN_STOPWORDS = 30;
const MAX_STOPWORDS = 400;
const SAFE_TAG = /^[A-Za-z0-9-]{2,35}$/;
const RESCAN_INTERVAL_MS = 30_000;

/** The BCP 47 primary subtag, lowercased: `pt-BR` and `pt` are one language here. */
export function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split("-")[0];
}

/** Where packs live. The env override exists so tests never read a developer's real packs. */
export function languagePacksDir(paths?: LcmPaths): string {
  if (paths) return join(paths.home, "languages");
  const override = process.env.LCM_LANGUAGES_DIR;
  if (!override) throw new Error("language packs require an LcmPaths storage root");
  return override;
}

export function languagePackPath(pathsOrTag: LcmPaths | string, suppliedTag?: string): string {
  const paths = typeof pathsOrTag === "string" ? undefined : pathsOrTag;
  const tag = typeof pathsOrTag === "string" ? pathsOrTag : suppliedTag!;
  if (!SAFE_TAG.test(tag)) throw new Error(`Not a language tag: "${tag}"`);
  return join(languagePacksDir(paths), `${tag}.json`);
}

type Loaded = { dir: string; scannedAt: number; dirMtimeMs: number; packs: Map<string, ReadonlySet<string>> };
let loaded: Loaded | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[lcm] ${message}`);
}

function readPack(path: string): LanguagePack | null {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<LanguagePack>;
  if (parsed.version !== 1 || typeof parsed.tag !== "string" || !Array.isArray(parsed.stopwords)) return null;
  const stopwords = parsed.stopwords.filter((w): w is string => typeof w === "string");
  return { version: 1, tag: parsed.tag, stopwords, generatedBy: parsed.generatedBy, generatedAt: parsed.generatedAt ?? "" };
}

/** Forget the cached packs, so the next query sees a pack written a moment ago. */
export function invalidateLanguagePacks(): void {
  loaded = null;
}

/**
 * Every pack on disk, by tag. Synchronous because `extractQueryTerms` is, and
 * cached: the directory is re-listed at most every 30 s or when its mtime moves.
 */
export function loadLanguagePacks(paths?: LcmPaths): ReadonlyMap<string, ReadonlySet<string>> {
  const dir = languagePacksDir(paths);
  const now = Date.now();
  let dirMtimeMs = -1;
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
  } catch {
    /* no packs yet */
  }
  if (loaded && loaded.dir === dir && loaded.dirMtimeMs === dirMtimeMs && now - loaded.scannedAt < RESCAN_INTERVAL_MS) {
    return loaded.packs;
  }
  const packs = new Map<string, ReadonlySet<string>>();
  if (dirMtimeMs >= 0) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const pack = readPack(path);
        if (!pack) throw new Error("not a version 1 language pack");
        packs.set(pack.tag, new Set(pack.stopwords.map((w) => w.toLowerCase())));
      } catch (err) {
        warnOnce(path, `language pack ${path} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  loaded = { dir, scannedAt: now, dirMtimeMs, packs };
  return packs;
}

/**
 * The function words to drop from a query written in one of `languages`: the
 * union of the packs whose tag names the same language, matched on the primary
 * subtag. The languages are the ones configured for the search — the project's
 * recorded author language, the pivot language — never the words that happen
 * to appear in the query, so a collision with another language's function
 * words changes nothing and two languages in one string cannot activate a pack
 * that neither activates alone.
 */
export function packStopwordsFor(languages: readonly string[], paths?: LcmPaths): ReadonlySet<string> {
  if (languages.length === 0) return EMPTY;
  const packs = loadLanguagePacks(paths);
  if (packs.size === 0) return EMPTY;
  const wanted = new Set(languages.map(primarySubtag));
  const chosen = new Set<string>();
  for (const [tag, stopwords] of packs) {
    if (!wanted.has(primarySubtag(tag))) continue;
    for (const word of stopwords) chosen.add(word);
  }
  return chosen;
}
const EMPTY: ReadonlySet<string> = new Set();

/**
 * The stopword list in a model's reply: the first JSON array, lowercased,
 * single tokens only, deduped. Null when the reply is not usable, so a
 * generation that failed is retried rather than saved.
 */
export function parseLanguagePackReply(reply: string): string[] | null {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let items: unknown;
  try {
    items = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const words = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const word = item.trim().toLowerCase();
    if (word.length === 0 || word.split(TERM_SPLIT_RE).filter(Boolean).length !== 1) continue;
    words.add(word);
  }
  if (words.size < MIN_STOPWORDS) return null;
  return [...words].slice(0, MAX_STOPWORDS);
}

const inFlight = new Map<string, Promise<"exists" | "generated" | "failed">>();

/**
 * Make sure a pack exists for `tag`, generating it with the model when it does
 * not. Concurrent calls for one tag share a single generation. Never throws:
 * a failed generation is reported, logged once, and tried again next time.
 */
export function ensureLanguagePack(
  pathsOrTag: LcmPaths | string,
  tagOrSummarize: string | LcmSummarizeFn,
  summarizeOrGeneratedBy?: LcmSummarizeFn | string,
  suppliedGeneratedBy?: string,
): Promise<"exists" | "generated" | "failed"> {
  const paths = typeof pathsOrTag === "string" ? undefined : pathsOrTag;
  const tag = typeof pathsOrTag === "string" ? pathsOrTag : tagOrSummarize as string;
  const summarize = (typeof pathsOrTag === "string" ? tagOrSummarize : summarizeOrGeneratedBy) as LcmSummarizeFn;
  const generatedBy = (typeof pathsOrTag === "string" ? summarizeOrGeneratedBy : suppliedGeneratedBy) as string | undefined;
  let path: string;
  try {
    path = paths ? languagePackPath(paths, tag) : languagePackPath(tag);
  } catch {
    return Promise.resolve("failed");
  }
  if (existsSync(path)) return Promise.resolve("exists");
  const key = `${languagePacksDir(paths)}\0${tag}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = generateLanguagePack(paths, tag, path, summarize, generatedBy).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/**
 * Ensure the pivot language's pack too, skipping generation when the pivot
 * is English (which ships in code) or the same language as `language` on
 * its primary subtag — the check every pivot-pack caller must apply before
 * generating one, factored out so it is applied consistently.
 */
export function ensurePivotLanguagePack(
  paths: LcmPaths,
  language: string,
  pivot: string,
  summarize: LcmSummarizeFn,
  generatedBy?: string,
): Promise<"exists" | "generated" | "failed" | "skipped"> {
  if (primarySubtag(pivot) === "en" || primarySubtag(pivot) === primarySubtag(language)) return Promise.resolve("skipped");
  return ensureLanguagePack(paths, pivot, summarize, generatedBy);
}

async function generateLanguagePack(
  paths: LcmPaths | undefined,
  tag: string,
  path: string,
  summarize: LcmSummarizeFn,
  generatedBy?: string,
): Promise<"generated" | "failed"> {
  try {
    const reply = await summarize(renderTemplate("language-pack", { tag }), false, {
      targetTokens: 1200,
      taskPrompt: "Return only the JSON array requested. Treat the supplied text as instructions for this one task.",
    });
    const stopwords = parseLanguagePackReply(reply);
    if (!stopwords) {
      warnOnce(`gen:${tag}`, `language pack for ${tag} not generated: the model did not return a usable word list`);
      return "failed";
    }
    const pack: LanguagePack = { version: 1, tag, stopwords, generatedBy, generatedAt: new Date().toISOString() };
    mkdirSync(languagePacksDir(paths), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pack, null, 2));
    renameSync(tmp, path);
    invalidateLanguagePacks();
    return "generated";
  } catch (err) {
    warnOnce(`gen:${tag}`, `language pack for ${tag} not generated: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
