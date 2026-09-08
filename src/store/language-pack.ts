import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "../daemon/project.js";
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
/** A query counts as being in a pack's language once this many of its words are that pack's function words. */
const MIN_PACK_HITS = 2;

/** Where packs live. The env override exists so tests never read a developer's real packs. */
export function languagePacksDir(): string {
  return process.env.LCM_LANGUAGES_DIR || join(BASE_DIR, "languages");
}

export function languagePackPath(tag: string): string {
  if (!SAFE_TAG.test(tag)) throw new Error(`Not a language tag: "${tag}"`);
  return join(languagePacksDir(), `${tag}.json`);
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
export function loadLanguagePacks(): ReadonlyMap<string, ReadonlySet<string>> {
  const dir = languagePacksDir();
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
 * The function words to drop from a query, chosen by the query itself: a pack
 * applies when at least two of the query's words are its function words, so a
 * stray collision ("a", "no") in another language changes nothing. Several
 * packs may apply to one query.
 */
export function packStopwordsFor(words: readonly string[]): ReadonlySet<string> {
  const packs = loadLanguagePacks();
  if (packs.size === 0) return EMPTY;
  const chosen = new Set<string>();
  for (const stopwords of packs.values()) {
    let hits = 0;
    for (const word of words) if (stopwords.has(word) && ++hits >= MIN_PACK_HITS) break;
    if (hits >= MIN_PACK_HITS) for (const word of stopwords) chosen.add(word);
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
  tag: string,
  summarize: LcmSummarizeFn,
  generatedBy?: string,
): Promise<"exists" | "generated" | "failed"> {
  let path: string;
  try {
    path = languagePackPath(tag);
  } catch {
    return Promise.resolve("failed");
  }
  if (existsSync(path)) return Promise.resolve("exists");
  const pending = inFlight.get(tag);
  if (pending) return pending;
  const task = generateLanguagePack(tag, path, summarize, generatedBy).finally(() => inFlight.delete(tag));
  inFlight.set(tag, task);
  return task;
}

async function generateLanguagePack(
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
    mkdirSync(languagePacksDir(), { recursive: true });
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
