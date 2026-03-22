import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";

export function createPromptSearchHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, cwd, session_id } = input;

    // Missing fields: return empty hints (not 400) — callers treat this as "no suggestions"
    if (!query || !cwd) {
      sendJson(res, 200, { hints: [] });
      return;
    }

    const dbPath = projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { hints: [] });
      return;
    }

    let db: InstanceType<typeof DatabaseSync> | undefined;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);

      const store = new PromotedStore(db);
      const maxResults = config.restoration.promptSearchMaxResults;
      const minScore = config.restoration.promptSearchMinScore;
      const snippetLength = config.restoration.promptSnippetLength;
      const halfLife = config.restoration.recencyHalfLifeHours;
      const crossSessionAffinity = config.restoration.crossSessionAffinity;

      const results = store.search(query, maxResults);

      const now = Date.now();
      const filtered = results.filter((r) => {
        const ageHours = (now - new Date(r.createdAt).getTime()) / 3_600_000;
        const recencyFactor = Math.pow(0.5, ageHours / halfLife);

        let sessionAffinity: number;
        if (session_id == null) {
          // No session context on query — skip affinity weighting
          sessionAffinity = 1.0;
        } else if (r.sessionId === session_id) {
          sessionAffinity = 1.0;
        } else {
          // null sessionId on entry or different session — cross-session
          sessionAffinity = crossSessionAffinity;
        }

        const score = Math.abs(r.rank) * recencyFactor * sessionAffinity;
        return score >= minScore;
      });

      const hints = filtered.map((r) =>
        r.content.length > snippetLength
          ? r.content.slice(0, snippetLength) + "..."
          : r.content
      );

      sendJson(res, 200, { hints });
    } catch {
      sendJson(res, 200, { hints: [] });
    } finally {
      db?.close();
    }
  };
}
