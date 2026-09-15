import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import { extractQueryTerms } from "../../store/fts5-query.js";

export function createGrepHandler(_config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, scope, mode, since } = input;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 200, { matches: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { matches: [] });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd, paths);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { matches: [] });
        return;
      }
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const engine = new RetrievalEngine(convStore, summStore);
      const searchMode = mode ?? "full_text";
      const result = await engine.grep({
        query,
        mode: searchMode,
        scope: scope ?? "both",
        since,
        terms: searchMode === "full_text" ? extractQueryTerms(query, paths) : undefined,
      });
      db.close();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { matches: [] });
    }
  };
}
