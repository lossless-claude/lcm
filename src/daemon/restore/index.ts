import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { wasSessionJustCompacted } from "../../db/session-compactions.js";
import { buildOrientationPrompt } from "../orientation.js";
import { validateCwd } from "../validate-cwd.js";
import { fenceOrEmpty, fitFencedText, remainingContextBudget } from "./budget.js";
import { readCodexContext } from "./codex.js";
import { withExistingProjectDb, withProjectDb } from "./db.js";
import { readInsights, type Insight } from "./insights.js";
import { readInstructionsSnapshot, refreshInstructionsSnapshot } from "./instructions.js";
import { readEpisodicContext, readPromotedMemories } from "./memory.js";

export type { Insight } from "./insights.js";

/**
 * Restore: the session's memory, assembled the way the harness that asked for it reads it.
 *
 * One entry point answers every SessionStart: which client is asking, why it fired, whether
 * the restore follows a compaction, which blocks are read and in what order, how they are
 * fitted to a byte budget, how they are fenced, and which connection reads them are all
 * decided here. The HTTP route is an adapter over `createRestore`; nothing else knows how a
 * restore is assembled.
 */

/** What the harness told the daemon. Every field is the raw payload value: the harness is
 * untrusted, so a caller forwards its fields without narrowing and this module decides what
 * they mean. Only the literal `"codex"` selects the Codex assembly; only a non-empty string
 * names a session; only the four known sources are honoured. */
export interface RestoreRequest {
  readonly client?: unknown;
  readonly sessionId?: unknown;
  readonly source?: unknown;
  readonly cwd?: unknown;
}

/**
 * The answer.
 *
 * - `context` — status 200. The context may be empty; its blocks are already fenced, so a
 *   caller must not fence them again. `insights` is absent, never empty, when no insight
 *   qualifies.
 * - `invalid-cwd` — status 400. The `cwd` was present and unusable; `message` is already
 *   sanitised for a client.
 * - `failed` — status 500. A fault with no thinner answer: the project database could not
 *   be opened, or an unexpected error. Every readable-but-missing section degrades instead.
 */
export type RestoreOutcome =
  | { readonly kind: "context"; readonly context: string; readonly insights?: readonly Insight[] }
  | { readonly kind: "invalid-cwd"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** A restore bound to one daemon's configuration and paths. Stateless and safe to call concurrently. */
export type Restore = (request: RestoreRequest) => Promise<RestoreOutcome>;

/** The request after the wire values have been narrowed once, for the whole call. */
type NormalizedRequest = {
  readonly client: string | undefined;
  readonly source: string | undefined;
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
};

export function createRestore(config: DaemonConfig, paths: LcmPaths): Restore {
  return async (request) => {
    let cwd: string | undefined;
    if (request.cwd) {
      try {
        // The wire value is untrusted; `validateCwd` is the module that decides what a usable
        // project directory is, and answers a message a client may read.
        cwd = validateCwd(typeof request.cwd === "string" ? request.cwd : "");
      } catch (err) {
        return { kind: "invalid-cwd", message: err instanceof Error ? err.message : "invalid cwd" };
      }
    }

    const input: NormalizedRequest = {
      client: typeof request.client === "string" ? request.client : undefined,
      source: typeof request.source === "string" ? request.source : undefined,
      sessionId: typeof request.sessionId === "string" && request.sessionId ? request.sessionId : undefined,
      cwd,
    };

    try {
      return input.client === "codex"
        ? await codexOutcome(input, config, paths)
        : await claudeOutcome(input, config, paths);
    } catch (err) {
      return { kind: "failed", message: err instanceof Error ? err.message : "restore failed" };
    }
  };
}

/** Claude Code's sources that name themselves a fresh start, so the compaction mark is not consulted. */
function isExplicitNonCompact(source: string | undefined): boolean {
  return source === "startup" || source === "resume" || source === "clear";
}

/**
 * Claude Code's restore.
 *
 * After a compaction it replays the saved CLAUDE.md snapshot and nothing else: that is the
 * one moment the harness's own copy is gone. Every other start returns the session's
 * episodic memory and the project's promoted knowledge, and refreshes the snapshot for the
 * next compaction without returning it — the harness injects those files itself, so echoing
 * them back would duplicate them.
 */
async function claudeOutcome(input: NormalizedRequest, config: DaemonConfig, paths: LcmPaths): Promise<RestoreOutcome> {
  const orientation = buildOrientationPrompt();
  const { cwd } = input;
  if (!cwd) return { kind: "context", context: orientation };

  // The harness says the restore follows a compaction. Replaying reads a snapshot, never
  // creates one, so an absent project database answers with the orientation alone.
  if (input.source === "compact") {
    const replayed = await withExistingProjectDb(cwd, paths, (db) => readInstructionsSnapshot(db));
    return { kind: "context", context: replayed ? [orientation, replayed].filter(Boolean).join("\n\n") : orientation };
  }

  return withProjectDb(cwd, paths, async (db) => {
    // The function-hooks caller carries no reason for firing, so the mark `/compact` left is
    // its only signal. An explicit fresh source rules it out without a probe.
    const postCompact = !isExplicitNonCompact(input.source)
      && input.sessionId !== undefined
      && wasSessionJustCompacted(db, input.sessionId);
    if (postCompact) {
      return { kind: "context", context: [orientation, readInstructionsSnapshot(db)].filter(Boolean).join("\n\n") };
    }

    let episodic = "";
    let promoted = "";
    try {
      episodic = await readEpisodicContext(db, input.sessionId, config.restoration.recentSummaries);
      promoted = fenceOrEmpty(readPromotedMemories(db, cwd, config), "project-knowledge");
      refreshInstructionsSnapshot(db, cwd);
    } catch { /* Non-fatal: return whatever was gathered before the failure. */ }

    const insights = readInsightsSafely(db, config);
    return {
      kind: "context",
      context: [orientation, episodic, promoted].filter(Boolean).join("\n\n"),
      ...(insights.length > 0 ? { insights } : {}),
    };
  });
}

/**
 * Codex's restore.
 *
 * The native host keeps its own instructions, so nothing here reads or writes the CLAUDE.md
 * snapshot, and the compaction mark is never consulted. What it returns is the
 * conversation's recent context and the project's promoted knowledge, each trimmed to what
 * is left of the injection budget.
 */
async function codexOutcome(input: NormalizedRequest, config: DaemonConfig, paths: LcmPaths): Promise<RestoreOutcome> {
  const orientation = buildOrientationPrompt();
  const parts = orientation ? [orientation] : [];
  const { cwd } = input;
  if (!cwd) return { kind: "context", context: parts.join("\n\n") };

  return withProjectDb(cwd, paths, async (db) => {
    const budget = config.restoration.maxInjectedMemoryBytes;
    try {
      const recent = await readCodexContext(
        db, input.sessionId, input.source,
        config.restoration.recentSummaries,
        remainingContextBudget(parts, budget),
      );
      if (recent) parts.push(recent);

      const knowledge = fitFencedText(
        readPromotedMemories(db, cwd, config).join("\n\n"),
        "project-knowledge",
        remainingContextBudget(parts, budget),
      );
      if (knowledge) parts.push(knowledge);
    } catch { /* Non-fatal: return whatever was gathered before the failure. */ }

    const insights = readInsightsSafely(db, config);
    return {
      kind: "context",
      context: parts.join("\n\n"),
      ...(insights.length > 0 ? { insights } : {}),
    };
  });
}

/** Insights are an extra, not the restore: a read that fails contributes none. */
function readInsightsSafely(db: DatabaseSync, config: DaemonConfig): Insight[] {
  try {
    return readInsights(db, config);
  } catch {
    return [];
  }
}