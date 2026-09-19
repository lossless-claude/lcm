import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "./config.js";
import type { LcmPaths } from "../lcm-paths.js";
import { projectMetaPath } from "./project.js";
import { readProjectMeta, updateProjectMeta } from "./project-meta.js";
import { createSummarizer, resolveEffectiveProvider, type CompactClient } from "./summarizer.js";
import { detectLanguage, sampleHumanTurns, LANGUAGE_SAMPLE_SIZE } from "../search/language.js";
import { ensureLanguagePack, ensurePivotLanguagePack, hasLanguagePack, primarySubtag } from "../store/language-pack.js";

/**
 * A project's language is read once, from the turns its author typed, and
 * recorded in the project's meta.json as `language`. The first time a
 * language is seen on this machine its language pack is generated too, so
 * search can drop that language's function words from queries — and so is
 * the pivot language's, since a `pivotQuery` is tokenised under that one.
 *
 * Detection runs after an ingest has been answered: the human turns are
 * sampled while the request still holds the database, the model call and
 * the file writes happen afterwards with no database handle at all.
 */

/** Fewer human turns than this and a corpus is too young to tell. */
const MIN_TURNS_FOR_DETECTION = LANGUAGE_SAMPLE_SIZE;

const inFlight = new Map<string, Promise<void>>();
const failed = new Set<string>();

function summarizerUnavailable(config: DaemonConfig, client?: CompactClient): boolean {
  return Boolean(config.summarizer?.mock) || resolveEffectiveProvider(config, client) === "disabled";
}

/**
 * Fire a pack generation without awaiting it, but still apply the same
 * once-per-daemon suppression as the catch blocks below when it fails.
 * `ensureLanguagePack` never throws — a failed generation resolves to
 * "failed" — so a fire-and-forget caller that ignores the result would
 * retry the generation on every later ingest for this project.
 */
function trackPackGeneration(metaPath: string, generating: Promise<"exists" | "generated" | "failed" | "skipped">): void {
  void generating.then((status) => {
    if (status !== "failed") return;
    failed.add(metaPath);
    console.warn(`[lcm] language pack generation failed for ${metaPath}; not retried until restart`);
  });
}

/**
 * Sample the corpus now (synchronously, on the caller's open connection) and
 * schedule detection for after the response. Returns the pending work so a
 * test can await it; production callers drop the promise.
 */
export function scheduleProjectLanguageDetection(
  cwd: string, db: DatabaseSync, config: DaemonConfig, paths: LcmPaths, client?: CompactClient,
): Promise<void> {
  if (summarizerUnavailable(config, client)) return Promise.resolve();
  const metaPath = projectMetaPath(cwd, paths);
  const pending = inFlight.get(metaPath);
  if (pending) return pending;
  if (failed.has(metaPath)) return Promise.resolve();
  const language = readProjectMeta(cwd, paths)?.language;
  if (typeof language === "string") return ensureExistingProjectPivotPack(metaPath, language, config, paths, client);
  const turns = sampleHumanTurns(db, paths);
  if (turns.length < MIN_TURNS_FOR_DETECTION) return Promise.resolve();
  const detection = detectAndRecord(cwd, metaPath, turns, config, paths, client).finally(() => inFlight.delete(metaPath));
  inFlight.set(metaPath, detection);
  return detection;
}

async function detectAndRecord(
  cwd: string, metaPath: string, turns: string[], config: DaemonConfig, paths: LcmPaths, client?: CompactClient,
): Promise<void> {
  try {
    const provider = resolveEffectiveProvider(config, client);
    const summarize = await createSummarizer(provider, config);
    if (!summarize) return;
    const language = await detectLanguage(turns, summarize);
    if (!language) throw new Error("the model did not name a language");
    if (typeof readProjectMeta(cwd, paths)?.language === "string") return;
    updateProjectMeta(cwd, paths, { language, languageDetectedAt: new Date().toISOString() });
    const generatedBy = `${provider}:${config.llm.model}`;
    trackPackGeneration(metaPath, ensureLanguagePack(paths, language, summarize, generatedBy));
    trackPackGeneration(metaPath, ensurePivotLanguagePack(paths, language, config.search.pivotLanguage, summarize, generatedBy));
  } catch (err) {
    // Once per daemon lifetime per project: a broken provider must not turn every ingest into a warning.
    failed.add(metaPath);
    console.warn(`[lcm] language detection skipped for ${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A project that already has a recorded language never re-detects, but a pivot
 * language configured after that detection still needs its pack: this is the
 * reconciliation path, run on every later ingest instead of only on first
 * detection. `ensureLanguagePack` is idempotent (it stats the pack file before
 * generating), so the repeated check is cheap once the pack exists.
 */
async function ensureExistingProjectPivotPack(
  metaPath: string, language: string, config: DaemonConfig, paths: LcmPaths, client?: CompactClient,
): Promise<void> {
  const pivot = config.search.pivotLanguage;
  if (primarySubtag(pivot) === primarySubtag(language)) return;
  try {
    // Steady state is a file check, not a provider client: the pack exists
    // (or is built in).
    if (hasLanguagePack(paths, pivot)) return;
    const provider = resolveEffectiveProvider(config, client);
    const summarize = await createSummarizer(provider, config);
    if (!summarize) return;
    const status = await ensurePivotLanguagePack(paths, language, pivot, summarize, `${provider}:${config.llm.model}`);
    if (status === "failed") {
      // Once per daemon lifetime per project: a broken provider must not turn every ingest into a warning.
      failed.add(metaPath);
      console.warn(`[lcm] pivot language pack generation skipped for ${metaPath}: the model did not return a usable word list`);
    }
  } catch (err) {
    // Once per daemon lifetime per project: a broken provider must not turn every ingest into a warning.
    failed.add(metaPath);
    console.warn(`[lcm] pivot language pack generation skipped for ${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test seam: forget which projects already failed or are in flight. */
export function resetProjectLanguageState(): void {
  inFlight.clear();
  failed.clear();
}
