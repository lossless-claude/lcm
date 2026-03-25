import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { ScrubEngine } from "../../scrub.js";

export function createStoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { text, tags = [], metadata = {}, cwd } = input;

    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    const projectPath = cwd || metadata.projectPath || "";
    if (!projectPath) {
      sendJson(res, 400, { error: "cwd or metadata.projectPath is required" });
      return;
    }

    const scrubber = new ScrubEngine(
      config.security?.sensitivePatterns ?? [],
      [],
    );
    const scrubbedText = scrubber.scrub(text);

    const dbPath = projectDbPath(projectPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      // Core: write to SQLite promoted table
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      const id = store.insert({
        content: scrubbedText,
        tags,
        projectId: metadata.projectId ?? "manual",
        sessionId: metadata.sessionId ?? "manual",
        depth: metadata.depth ?? 0,
        confidence: 1.0,
      });

      sendJson(res, 200, { stored: true, id });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "store failed" });
    } finally {
      db.close();
    }
  };
}
