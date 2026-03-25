import { EventsDb, type EventRow } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { PromotedStore } from "../../db/promoted.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { projectId, projectDbPath } from "../project.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { DaemonConfig } from "../config.js";

const AUTO_TAGS: Record<string, string> = {
  decision: "category:preference",
  error: "category:gotcha",      // overridden to "category:solution" for error→fix pairs
  plan: "category:decision",
  role: "category:user-context",
  git: "category:workflow",
  env: "category:environment",
  file: "category:pattern",
};

const CORRELATION_WINDOW = 20;

interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
}

function correlateErrors(events: EventRow[]): void {
  // Group by session
  const bySession = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  for (const sessionEvents of bySession.values()) {
    // Sort by seq
    sessionEvents.sort((a, b) => a.seq - b.seq);

    // Find error→success pairs
    for (let i = 0; i < sessionEvents.length; i++) {
      const event = sessionEvents[i];
      if (event.category !== "error") continue;

      // Look for closest preceding error pattern match in the next CORRELATION_WINDOW events
      const errorPrefix = event.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

      for (let j = i + 1; j < sessionEvents.length && (sessionEvents[j].seq - event.seq) <= CORRELATION_WINDOW; j++) {
        const candidate = sessionEvents[j];
        if (candidate.category === "error") continue; // skip other errors
        const candidatePrefix = candidate.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

        // Match on command prefix overlap — guard against empty match token (data without colon)
        const matchToken = errorPrefix.split(":")[1]?.trim().split(" ")[0] ?? "";
        if (matchToken && candidatePrefix.includes(matchToken)) {
          // Correlation found — this is an error→fix pair
          // Set the tag to 'category:solution' (overriding 'category:gotcha' from AUTO_TAGS)
          (candidate as EventRow & { auto_tag?: string }).auto_tag = "category:solution";
          (candidate as EventRow & { _correlatedErrorId?: number })._correlatedErrorId = event.event_id;
          break; // only correlate with closest match
        }
      }
    }
  }
}

export function createPromoteEventsHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
      return;
    }

    const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };

    try {
      const sidecarPath = eventsDbPath(cwd);
      const edb = new EventsDb(sidecarPath);

      try {
        const events = edb.getUnprocessed();
        if (events.length === 0) {
          sendJson(res, 200, { ...result, message: "no unprocessed events" });
          return;
        }

        // Correlate error→fix pairs
        correlateErrors(events);

        // Open main project DB for promotion
        const pid = projectId(cwd);
        const dbPath = projectDbPath(cwd);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          const store = new PromotedStore(db);

          const thresholds = config.compaction.promotionThresholds;
          const eventConf = thresholds.eventConfidence ?? {
            decision: 0.5, plan: 0.7, errorFix: 0.4, batch: 0.3, pattern: 0.2,
          };

          const processedIds: number[] = [];

          for (const event of events) {
            try {
              const autoTag = (event as EventRow & { auto_tag?: string }).auto_tag;
              const tag = autoTag ?? AUTO_TAGS[event.category] ?? `category:${event.category}`;
              let confidence: number;

              // Determine confidence by tier
              if (event.priority === 1) {
                // Tier 1: immediate
                if (event.category === "plan") {
                  confidence = eventConf.plan ?? 0.7;
                } else if ((event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId) {
                  confidence = eventConf.errorFix ?? 0.4;
                  result.correlated++;
                } else {
                  confidence = eventConf.decision ?? 0.5;
                }
              } else if (event.priority === 2) {
                // Tier 2: batch
                confidence = eventConf.batch ?? 0.3;
                // Check if this is a correlated fix event
                if ((event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId) {
                  confidence = eventConf.errorFix ?? 0.4;
                  result.correlated++;
                }
              } else {
                // Tier 3: pattern-only — only promote if already in promoted table
                const existing = store.search(event.data, 1, undefined, pid);
                if (existing.length === 0) {
                  processedIds.push(event.event_id);
                  result.skipped++;
                  continue;
                }
                confidence = eventConf.pattern ?? 0.2;
              }

              // Set correlation chain
              const correlatedErrorId = (event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId;
              if (correlatedErrorId) {
                edb.setPrevEventId(event.event_id, correlatedErrorId);
              }

              // Promote via existing dedup pipeline
              await deduplicateAndInsert({
                store,
                content: event.data,
                tags: [tag, "source:passive-capture", `hook:${event.source_hook}`],
                projectId: pid,
                sessionId: event.session_id,
                depth: 0,
                confidence,
                thresholds: {
                  dedupBm25Threshold: thresholds.dedupBm25Threshold ?? 15,
                  dedupCandidateLimit: thresholds.dedupCandidateLimit ?? 100,
                },
              });

              processedIds.push(event.event_id);
              result.promoted++;
            } catch {
              processedIds.push(event.event_id); // mark processed even on error to avoid stuck events
              result.errors++;
            }
          }

          edb.markProcessed(processedIds);
        } finally {
          closeLcmConnection(dbPath);
        }
      } finally {
        edb.close();
      }
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
      return;
    }

    sendJson(res, 200, result);
  };
}
