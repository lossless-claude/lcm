import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeLogError } from "./hook-errors.js";

type PromptSearchResponse = {
  hints: string[];
  ids?: string[];
};

const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
- decision: architectural/design choice with trade-offs
- preference: user working style or tool preference
- root-cause: bug cause that took effort to uncover
- pattern: codebase convention not documented elsewhere
- gotcha: non-obvious pitfall or footgun
- solution: non-trivial fix worth remembering
- workflow: multi-step process that works

Tag prefixes: type: | scope: | project: | sprint: | source: | priority: | owner: | signal:
Usage: lcm_store(text: "concise insight with why", tags: ["type:decision", "project:<repo>"])

When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:
lcm_store(text: "Acted on memory <id> — <one-line how>", tags: ["signal:memory_used", "memory_id:<id>"])
</learning-instruction>`;

export async function handleUserPromptSubmit(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: LEARNING_INSTRUCTION };

  try {
    const input = JSON.parse(stdin || "{}");
    if (!input.prompt || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }

    // Sidecar event extraction — must happen before prompt-search, must never throw
    try {
      const { extractUserPromptEvents } = await import("./extractors.js");
      const { EventsDb } = await import("./events-db.js");
      const { eventsDbPath } = await import("../db/events-path.js");

      const prompt = String(input.prompt ?? "");
      const events = extractUserPromptEvents(prompt);

      if (events.length > 0 && input.session_id && typeof input.session_id === "string") {
        const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
        const db = new EventsDb(eventsDbPath(cwd));
        try {
          for (const event of events) {
            db.insertEvent(input.session_id, event, "UserPromptSubmit");
          }
        } finally {
          db.close();
        }
      }
    } catch (e) {
      safeLogError("UserPromptSubmit", e, {
        cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR,
        sessionId: input.session_id,
      });
    }

    const result = await client.post<PromptSearchResponse>("/prompt-search", {
      query: input.prompt,
      cwd: input.cwd,
      session_id: input.session_id,
    });

    if (!result.hints || result.hints.length === 0) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }

    const snippets = result.hints.map((h) => `- ${h}`).join("\n");
    const idComment = result.ids && result.ids.length > 0
      ? `\n<!-- surfaced-memory-ids: ${result.ids.join(",")} -->`
      : "";
    const hint = `<memory-context>\nRelevant context from previous sessions (use lcm_expand for details):\n${snippets}${idComment}\n</memory-context>`;
    return { exitCode: 0, stdout: `${hint}\n${LEARNING_INSTRUCTION}` };
  } catch {
    return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
  }
}
