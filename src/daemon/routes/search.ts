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
import type { QmdClient } from "../../search/qmd-client.js";
import { sanitizeError } from "../safe-error.js";
import { qmdSearchInput } from "./qmd-input.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSearchHandler(qmd?: Pick<QmdClient, "search">): RouteHandler {
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
    const errors: string[] = [];

    if (input.backend !== undefined && !["native", "qmd"].includes(input.backend)) {
      sendJson(res, 400, { error: "backend must be native or qmd" });
      return;
    }
    if (input.backend === "qmd") {
      let request;
      try {
        request = qmdSearchInput(input, cwd);
      } catch (err) {
        sendJson(res, 400, { error: describeError(err) });
        return;
      }
      try {
        if (!qmd) throw new Error("QMD worker is unavailable");
        const result = await qmd.search(request);
        sendJson(res, 200, { backend: "qmd", ...result });
        return;
      } catch (err) {
        errors.push(`qmd: ${sanitizeError(describeError(err))}`);
      }
    }

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
              promoted = promotedStore.search(query, limit, filterTags);
            } catch (err) {
              console.warn(`[lcm] /search promoted layer failed: ${describeError(err)}`);
              errors.push(`promoted: ${describeError(err)}`);
            }
          }
        } catch (err) {
          console.warn(`[lcm] /search database open failed: ${describeError(err)}`);
          errors.push(`database: ${describeError(err)}`);
        } finally {
          db.close();
        }
      }
    }

    const fallback = input.backend === "qmd" ? { backend: "native", fallback: true } : {};
    sendJson(res, 200, errors.length > 0 ? { ...fallback, episodic, promoted, errors } : { episodic, promoted });
  };
}
