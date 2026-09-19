import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath } from "../project.js";
import { openProject, projectGroup, resolveSourceCwd } from "../project-group.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { collectLegacyUsageCounts } from "../../db/recall.js";
import { parseStoredTags } from "../../db/votes.js";
import { validateCwd } from "../validate-cwd.js";

export type StaleCandidate = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  ownerProjectId: string;
  confidence: number;
  createdAt: string;
  daysSinceCreated: number;
  surfacingCount: number;
  usageCount: number;
};

export function createReviewStaleHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd as string);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    try {
      // Handle archive/revive actions
      const action = input.action as string | undefined;
      const targetId = input.target_id as string | undefined;

      if (action && targetId) {
        if (action !== "archive" && action !== "revive") {
          sendJson(res, 400, { error: `Unknown action: ${action}. Use "archive" or "revive".` });
          return;
        }

        openProject(cwd, paths);
        const requestedOwner = input.owner_project_id;
        if (requestedOwner !== undefined && (typeof requestedOwner !== "string" || requestedOwner.trim() === "")) {
          sendJson(res, 400, { error: "owner_project_id must be a non-empty string" });
          return;
        }
        const ownerCwd = requestedOwner === undefined
          ? null
          : resolveSourceCwd(cwd, requestedOwner, paths);
        if (requestedOwner !== undefined && !ownerCwd) {
          sendJson(res, 404, { error: "Memory owner was not found in this project group" });
          return;
        }
        const members = ownerCwd
          ? projectGroup(cwd, paths).filter((member) => member.cwd === ownerCwd)
          : projectGroup(cwd, paths);
        const matches = members.filter((member) => {
          const dbPath = projectDbPath(member.cwd, paths);
          if (!existsSync(dbPath)) return false;
          try {
            const db = getLcmConnection(dbPath);
            try {
              runLcmMigrations(db);
              return new PromotedStore(db).getById(targetId) !== null;
            } finally {
              closeLcmConnection(dbPath);
            }
          } catch {
            return false;
          }
        });
        if (matches.length === 0) {
          sendJson(res, 404, { error: `Memory ${targetId} not found` });
          return;
        }
        if (!ownerCwd && matches.length > 1) {
          sendJson(res, 409, { error: `Memory ${targetId} is ambiguous across this project group; provide owner_project_id` });
          return;
        }

        const member = matches[0];
        const dbPath = projectDbPath(member.cwd, paths);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          const store = new PromotedStore(db);
          if (action === "archive") {
            db.exec("BEGIN IMMEDIATE");
            try {
              store.archive(targetId);
              db.exec("COMMIT");
            } catch (err) {
              try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
              throw err;
            }
          } else {
            // PromotedStore.revive owns the transaction that keeps promoted and FTS in sync.
            store.revive(targetId);
          }
          sendJson(res, 200, { action: action === "archive" ? "archived" : "revived", id: targetId, ownerProjectId: member.projectId });
          return;
        } finally {
          closeLcmConnection(dbPath);
        }
      }

      openProject(cwd, paths);
      const stale: StaleCandidate[] = [];
      const members = projectGroup(cwd, paths);
      const groupDatabases = new Map<string, ReturnType<typeof getLcmConnection>>();
      try {
        for (const member of members) {
          const dbPath = projectDbPath(member.cwd, paths);
          if (!existsSync(dbPath)) continue;
          try {
            const db = getLcmConnection(dbPath);
            runLcmMigrations(db);
            groupDatabases.set(member.projectId, db);
          } catch {
            try { closeLcmConnection(dbPath); } catch { /* no ref was acquired */ }
          }
        }
        const legacyUsage = collectLegacyUsageCounts(groupDatabases);
        const legacyUsageByOwner = legacyUsage.byOwner;
        for (const member of members) {
          const db = groupDatabases.get(member.projectId);
          if (!db) continue;
          const staleRows = new PromotedStore(db).findStale({
            staleAfterDays: config.restoration.staleAfterDays,
            staleSurfacingWithoutUseLimit: config.restoration.staleSurfacingWithoutUseLimit,
            projectId: input.project_id as string | undefined,
            legacyUsageCounts: legacyUsageByOwner.get(member.projectId),
            ambiguousIds: legacyUsage.ambiguousIds,
          });
          stale.push(...staleRows.flatMap((row) => {
            const tags = parseStoredTags(row.tags);
            return tags ? [{
              id: row.id, content: row.content, tags,
              projectId: row.project_id, ownerProjectId: member.projectId,
              confidence: row.confidence, createdAt: row.created_at, daysSinceCreated: row.daysSinceCreated,
              surfacingCount: row.surfacingCount, usageCount: row.usageCount,
            }] : [];
          }));
        }
      } finally {
        for (const member of members) {
          if (groupDatabases.has(member.projectId)) closeLcmConnection(projectDbPath(member.cwd, paths));
        }
      }

      sendJson(res, 200, { stale, total: stale.length });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "review-stale failed" });
    }
  };
}
