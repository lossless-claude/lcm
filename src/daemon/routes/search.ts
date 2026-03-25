import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";
import { PromotedStore } from "../../db/promoted.js";
import { validateCwd } from "../validate-cwd.js";

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

    if (cwd) {
      const dbPath = projectDbPath(cwd);
      if (existsSync(dbPath)) {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        try {
          runLcmMigrations(db);

          // Episodic: FTS5 search across messages + summaries
          if (activeLayers.includes("episodic")) {
            try {
              const convStore = new ConversationStore(db);
              const summStore = new SummaryStore(db);
              const engine = new RetrievalEngine(convStore, summStore);
              const result = await engine.grep({ query, mode: "full_text", scope: "both" });
              const allMatches = [...result.messages, ...result.summaries];
              const episodicMatches = filterTags
                ? allMatches.filter((m) => {
                    const t = (m as Record<string, unknown>).tags;
                    return Array.isArray(t) && filterTags.every(ft => t.includes(ft));
                  })
                : allMatches;
              episodic = episodicMatches.slice(0, limit);
            } catch { /* non-fatal */ }
          }

          // Promoted: FTS5 search across promoted memories
          if (activeLayers.includes("promoted")) {
            try {
              const promotedStore = new PromotedStore(db);
              promoted = promotedStore.search(query, limit, filterTags);
            } catch { /* non-fatal */ }
          }
        } catch { /* non-fatal */ }
        finally {
          db.close();
        }
      }
    }

    sendJson(res, 200, { episodic, promoted });
  };
}
