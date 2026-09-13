import { existsSync, mkdirSync, statSync } from "node:fs";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath, projectDir } from "../project.js";
import { openProject, projectGroup } from "../project-group.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { sanitizeError } from "../safe-error.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { isVoteRecord, parseVote, voteTagsOf } from "../../db/votes.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";

/** Cache entry for a per-project ScrubEngine. */
interface ScrubCacheEntry {
  engine: ScrubEngine;
  /** mtime of sensitive-patterns.txt at the time the engine was created (ms). */
  mtime: number;
}

const SCRUB_CACHE_MAX = 100;
const scrubCache = new Map<string, ScrubCacheEntry>();

async function getScrubEngine(config: DaemonConfig, projDir: string): Promise<ScrubEngine> {
  const patternsFile = `${projDir}/sensitive-patterns.txt`;
  let mtime = 0;
  try { mtime = statSync(patternsFile).mtimeMs; } catch { /* file absent — mtime stays 0 */ }

  const cached = scrubCache.get(projDir);
  if (cached && cached.mtime === mtime) return cached.engine;

  const engine = await ScrubEngine.forProject(config.security?.sensitivePatterns ?? [], projDir);
  // Evict oldest entry when at capacity (simple LRU via insertion-order Map)
  if (scrubCache.size >= SCRUB_CACHE_MAX) {
    scrubCache.delete(scrubCache.keys().next().value as string);
  }
  scrubCache.set(projDir, { engine, mtime });
  return engine;
}

/**
 * The cwd of the group member whose database currently holds an active `memoryId`, checked
 * self first. Null when no member of the group has it. Voting on a memory in a sibling
 * checkout must count against that memory rather than creating an orphaned reference in the
 * voter's own project.
 */
function resolveVoteTargetCwd(projectPath: string, memoryId: string): string | null {
  for (const member of projectGroup(projectPath)) {
    const dbPath = projectDbPath(member.cwd);
    if (!existsSync(dbPath)) continue;
    // The shared pool: a group member can be the database the daemon already serves, and a
    // second handle to it would miss the pool's WAL, foreign-key and busy-timeout setup.
    let db: DatabaseSync | undefined;
    try {
      db = getLcmConnection(dbPath);
      const row = new PromotedStore(db).getById(memoryId);
      if (row && !row.archived_at) return member.cwd;
    } catch {
      continue;
    } finally {
      if (db) closeLcmConnection(dbPath);
    }
  }
  return null;
}

/**
 * Coalesces a vote with any earlier active vote from the same real session on the same
 * memory: an identical repeat is a no-op (its id is returned unchanged), an opposite vote
 * archives the earlier one so only the latest per session ever counts. A session id that
 * fell back to "manual" cannot distinguish agents, so no coalescing happens for it — each
 * such vote is counted on its own.
 */
function reconcileSessionVote(
  store: PromotedStore,
  db: DatabaseSync,
  sessionId: string | undefined,
  memoryId: string,
  direction: "+1" | "-1",
): { existingId: string } | null {
  if (!sessionId || sessionId === "manual") return null;

  const rows = db.prepare(
    `SELECT id, tags FROM promoted
     WHERE archived_at IS NULL AND session_id = ?
     AND tags LIKE '%"signal:memory_vote"%'`
  ).all(sessionId) as Array<{ id: string; tags: string }>;

  for (const row of rows) {
    const vote = voteTagsOf(JSON.parse(row.tags) as string[]);
    if (!vote || vote.memoryId !== memoryId) continue;
    if (vote.direction === direction) return { existingId: row.id };
    store.archive(row.id);
    return null;
  }
  return null;
}

export function createStoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { text, tags = [], metadata = {} } = input;

    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    const rawProjectPath = input.cwd || metadata.projectPath || "";
    if (!rawProjectPath) {
      sendJson(res, 400, { error: "cwd or metadata.projectPath is required" });
      return;
    }

    let projectPath: string;
    try {
      projectPath = validateCwd(rawProjectPath);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    let targetPath = projectPath;
    let vote: { memoryId: string; direction: "+1" | "-1" } | null = null;

    if (isVoteRecord(tags)) {
      const parsed = parseVote(tags, text);
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      // Register this checkout first: projectGroup only knows checkouts it has seen, so a
      // first vote from an unregistered one would not find a target held by a sibling.
      openProject(projectPath);
      const resolved = resolveVoteTargetCwd(projectPath, parsed.memoryId);
      if (!resolved) {
        sendJson(res, 400, { error: `memory_id ${parsed.memoryId} was not found (or is archived) in this project or its group` });
        return;
      }
      targetPath = resolved;
      vote = { memoryId: parsed.memoryId, direction: parsed.direction };
    }

    // From targetPath, not projectPath: a vote can land in a sibling checkout, and that
    // checkout's own sensitive-patterns.txt is what governs what may be written there.
    const scrubber = await getScrubEngine(config, projectDir(targetPath));
    const scrubbedText = scrubber.scrub(text);

    const dbPath = projectDbPath(targetPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    // The shared pool, like the resolver above: targetPath can be a sibling the daemon
    // already serves, and a second handle to it would miss the pool's setup.
    const db = getLcmConnection(dbPath);
    try {
      // Core: write to SQLite promoted table
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      const insert = () => store.insert({
        content: scrubbedText,
        tags,
        projectId: metadata.projectId ?? "manual",
        sessionId: metadata.sessionId ?? "manual",
        depth: metadata.depth ?? 0,
        confidence: 1.0,
      });

      if (!vote) {
        sendJson(res, 200, { stored: true, id: insert() });
        return;
      }

      // One transaction: archiving the superseded vote and writing its replacement touch
      // promoted and promoted_fts, and a failure between them would leave the session with
      // no active vote or the two tables disagreeing.
      db.exec("BEGIN IMMEDIATE");
      let id: string;
      try {
        // Rechecked here, not only before the scrub: /review-stale may have archived the
        // target in between, and a vote against an archived memory is counted by nothing.
        const target = store.getById(vote.memoryId);
        if (!target || target.archived_at) {
          db.exec("ROLLBACK");
          sendJson(res, 400, { error: `memory_id ${vote.memoryId} was not found (or is archived) in this project or its group` });
          return;
        }
        const coalesced = reconcileSessionVote(store, db, metadata.sessionId, vote.memoryId, vote.direction);
        if (coalesced) {
          db.exec("COMMIT");
          sendJson(res, 200, { stored: true, id: coalesced.existingId });
          return;
        }
        id = insert();
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
        throw e;
      }

      sendJson(res, 200, { stored: true, id });
    } catch (err) {
      sendJson(res, 500, { error: sanitizeError(err instanceof Error ? err.message : "store failed") });
    } finally {
      closeLcmConnection(dbPath);
    }
  };
}
