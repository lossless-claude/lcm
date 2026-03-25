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
import { validateCwd } from "../validate-cwd.js";

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
