import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { searchNativeHistory } from "../../search/native-history.js";
import { PromotedStore } from "../../db/promoted.js";
import { validateCwd } from "../validate-cwd.js";
import { projectRef } from "../project-group.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSearchHandler(): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, limit = 5, layers, tags } = input;
    const activeLayers: string[] = layers ?? ["episodic", "promoted"];
    const filterTags: string[] | undefined = Array.isArray(tags) && tags.length > 0 ? tags : undefined;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    if (input.backend !== undefined && input.backend !== "native") {
      sendJson(res, 400, { error: "Only native search is available in this build" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
        return;
      }
    }

    let episodic: unknown[] = [];
    let promoted: unknown[] = [];
    const errors: string[] = [];

    if (cwd) {
      const dbPath = projectDbPath(cwd);
      if (existsSync(dbPath)) {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          // Episodic: FTS5 search across messages + summaries
          if (activeLayers.includes("episodic")) {
            try {
              // History records do not carry promoted-memory tags.
              episodic = filterTags ? [] : await searchNativeHistory(db, { query, limit, project: projectRef(cwd) });
            } catch (err) {
              // Non-fatal for the response, but never silent: a real failure
              // (malformed FTS5 syntax, missing table, corrupt index) must be
              // distinguishable from a query that legitimately matched nothing.
              console.warn(`[lcm] /search episodic layer failed: ${describeError(err)}`);
              errors.push(`episodic: ${describeError(err)}`);
            }
          }

          // Promoted: FTS5 search across promoted memories
          if (activeLayers.includes("promoted")) {
            try {
              const promotedStore = new PromotedStore(db);
              promoted = promotedStore.search(query, limit, filterTags)
                .map(result => ({ ...result, project: projectRef(cwd) }));
            } catch (err) {
              console.warn(`[lcm] /search promoted layer failed: ${describeError(err)}`);
              errors.push(`promoted: ${describeError(err)}`);
            }
          }
        } catch (err) {
          console.warn(`[lcm] /search database open failed: ${describeError(err)}`);
          errors.push(`database: ${describeError(err)}`);
        } finally {
          closeLcmConnection(dbPath);
        }
      }
    }

    sendJson(res, 200, errors.length > 0 ? { episodic, promoted, errors } : { episodic, promoted });
  };
}
