import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "./config.js";
import { projectMetaPath } from "./project.js";
import { createSummarizer, resolveEffectiveProvider } from "./summarizer.js";
import { detectLanguage, sampleHumanTurns, LANGUAGE_SAMPLE_SIZE } from "../search/language.js";
import { ensureLanguagePack } from "../store/language-pack.js";

/**
 * A project's language is read once, from the turns its author typed, and
 * recorded in the project's meta.json as `language`. The first time a
 * language is seen on this machine its language pack is generated too, so
 * search can drop that language's function words from queries.
 *
 * Detection runs after an ingest has been answered: the human turns are
 * sampled while the request still holds the database, the model call and
 * the file writes happen afterwards with no database handle at all.
 */

/** Fewer human turns than this and a corpus is too young to tell. */
const MIN_TURNS_FOR_DETECTION = LANGUAGE_SAMPLE_SIZE;

const inFlight = new Set<string>();
const failed = new Set<string>();

function readMeta(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function summarizerUnavailable(config: DaemonConfig): boolean {
  return Boolean(config.summarizer?.mock) || resolveEffectiveProvider(config) === "disabled";
}

/**
 * Sample the corpus now (synchronously, on the caller's open connection) and
 * schedule detection for after the response. Returns the pending work so a
 * test can await it; production callers drop the promise.
 */
export function scheduleProjectLanguageDetection(cwd: string, db: DatabaseSync, config: DaemonConfig): Promise<void> {
  if (summarizerUnavailable(config)) return Promise.resolve();
  const metaPath = projectMetaPath(cwd);
  if (inFlight.has(metaPath) || failed.has(metaPath)) return Promise.resolve();
  if (typeof readMeta(metaPath).language === "string") return Promise.resolve();
  const turns = sampleHumanTurns(db);
  if (turns.length < MIN_TURNS_FOR_DETECTION) return Promise.resolve();
  inFlight.add(metaPath);
  return detectAndRecord(metaPath, turns, config).finally(() => inFlight.delete(metaPath));
}

async function detectAndRecord(metaPath: string, turns: string[], config: DaemonConfig): Promise<void> {
  try {
    const provider = resolveEffectiveProvider(config);
    const summarize = await createSummarizer(provider, config);
    if (!summarize) return;
    const language = await detectLanguage(turns, summarize);
    if (!language) throw new Error("the model did not name a language");
    const meta = readMeta(metaPath);
    if (typeof meta.language === "string") return;
    writeFileSync(metaPath, JSON.stringify({ ...meta, language, languageDetectedAt: new Date().toISOString() }, null, 2));
    await ensureLanguagePack(language, summarize, `${provider}:${config.llm.model}`);
  } catch (err) {
    // Once per daemon lifetime per project: a broken provider must not turn every ingest into a warning.
    failed.add(metaPath);
    console.warn(`[lcm] language detection skipped for ${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test seam: forget which projects already failed or are in flight. */
export function resetProjectLanguageState(): void {
  inFlight.clear();
  failed.clear();
}
