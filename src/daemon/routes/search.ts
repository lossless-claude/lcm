import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { searchNativeHistory } from "../../search/native-history.js";
import { searchHistoryGroup } from "../../search/group-history.js";
import { searchPromotedGroup } from "../../search/group-promoted.js";
import { pivotLanguagesFor } from "../../search/pivot-language.js";
import { combinedQueryTerms, combineWithPivotQuery } from "../../store/fts5-query.js";
import { validateCwd } from "../validate-cwd.js";
import { projectRef } from "../project-group.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSearchHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, pivotQuery, limit = 5, layers, tags } = input;
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

    // The caller's own translation is combined here, once, and the term set travels with
    // the string: each layer below would otherwise re-tokenise the mixture and pick one
    // language's stopword pack for both, dropping the terms the pivot just added.
    const rawPivot = typeof pivotQuery === "string" ? pivotQuery : undefined;
    const searchQuery = combineWithPivotQuery(String(query), rawPivot);
    const searchTerms = combinedQueryTerms(String(query), rawPivot) ?? undefined;

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
              // Episodic union is gated: see search.unionHistoryAcrossGroup.
              episodic = filterTags
                ? []
                : config.search.unionHistoryAcrossGroup
                  ? await searchHistoryGroup(cwd, { query: searchQuery, limit, terms: searchTerms })
                  : await searchNativeHistory(db, { query: searchQuery, limit, terms: searchTerms, project: projectRef(cwd) });
            } catch (err) {
              // Non-fatal for the response, but never silent: a real failure
              // (malformed FTS5 syntax, missing table, corrupt index) must be
              // distinguishable from a query that legitimately matched nothing.
              console.warn(`[lcm] /search episodic layer failed: ${describeError(err)}`);
              errors.push(`episodic: ${describeError(err)}`);
            }
          }

          // Promoted: FTS5 across every checkout of this repository. Promoted
          // memory is always unioned; only the episodic union is gated on
          // measurement.
          if (activeLayers.includes("promoted")) {
            try {
              promoted = searchPromotedGroup(cwd, { query: searchQuery, limit, tags: filterTags, terms: searchTerms }).hits;
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

    // The two languages travel with every result: a caller that searched
    // without a pivotQuery can see from the response that one applies and retry.
    const languages = cwd ? pivotLanguagesFor(cwd, config.search.pivotLanguage) : undefined;
    sendJson(res, 200, {
      episodic,
      promoted,
      ...(languages?.authorLanguage ? { authorLanguage: languages.authorLanguage, pivotLanguage: languages.pivotLanguage } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });
  };
}
