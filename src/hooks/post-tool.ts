// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";

const LOG_PATH = join(homedir(), ".lossless-claude", "logs", "events.log");

function logError(hook: string, error: unknown, sessionId?: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const msg = JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      error: error instanceof Error ? error.message : String(error),
      session_id: sessionId,
    });
    appendFileSync(LOG_PATH, msg + "\n");
  } catch {
    // Last resort: silently fail
  }
}

function firePromoteEvents(port: number, cwd: string): void {
  try {
    const json = JSON.stringify({ cwd });
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/promote-events",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
    });
    // Deferred unref — same pattern as session-end.ts fire-and-forget functions
    req.on("socket", (socket) => {
      req.on("finish", () => (socket as import("node:net").Socket).unref());
    });
    req.on("error", () => {}); // swallow
    req.write(json);
    req.end();
  } catch {
    // daemon down — events stay in sidecar for later promotion
  }
}

export async function handlePostToolUse(
  stdin: string,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin);
    const { session_id, tool_name, tool_input, tool_response, tool_output } = input;

    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    const events = extractPostToolEvents({ tool_name, tool_input: tool_input ?? {}, tool_response, tool_output });
    if (events.length === 0) return { exitCode: 0, stdout: "" };

    const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const dbPath = eventsDbPath(cwd);
    const db = new EventsDb(dbPath);

    try {
      for (const event of events) {
        db.insertEvent(session_id, event, "PostToolUse");
      }

      // Tier 1: fire-and-forget daemon promotion for high-priority events.
      // The /promote-events route uses getUnprocessed() which reads processed_at IS NULL,
      // so events already promoted by this call won't be re-promoted by the batch route
      // at session-end. No additional de-duplication guard needed.
      const hasPriority1 = events.some(e => e.priority === 1);
      if (hasPriority1) {
        const port = input.daemon_port ?? 3737;
        firePromoteEvents(port, cwd);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    logError("PostToolUse", error);
  }

  return { exitCode: 0, stdout: "" };
}
