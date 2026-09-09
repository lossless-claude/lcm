import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";
import { ExpansionOrchestrator } from "../../expansion.js";
import { validateCwd } from "../validate-cwd.js";
import { resolveSourceCwd } from "../project-group.js";

export function createExpandHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId, depth = 1 } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch {
        sendJson(res, 200, { expanded: null, error: "project not found" });
        return;
      }
    }

    if (!cwd || !existsSync(projectDbPath(cwd))) {
      sendJson(res, 200, { expanded: null, error: "project not found" });
      return;
    }

    // A search result carries the project it was read from. Ids are
    // AUTOINCREMENT per database, so expanding one against the request's own
    // project would silently return a different node.
    const source = resolveSourceCwd(cwd, input.projectId);
    if (!source) {
      sendJson(res, 200, { expanded: null, error: "project not in group" });
      return;
    }

    try {
      const dbPath = projectDbPath(source);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const retrieval = new RetrievalEngine(convStore, summStore);
      const orchestrator = new ExpansionOrchestrator(retrieval);
      const result = await orchestrator.expand({ summaryIds: [nodeId], maxDepth: depth, includeMessages: true });
      db.close();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { expanded: null, error: err instanceof Error ? err.message : "expansion failed" });
    }
  };
}
