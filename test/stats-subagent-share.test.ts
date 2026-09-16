import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, afterEach } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { collectStats } from "../src/stats.js";
import { ConversationStore, type SubagentAttributionInput } from "../src/store/conversation-store.js";
import { createLcmPaths } from "../src/lcm-paths.js";

type Session = { sessionId: string } & SubagentAttributionInput;

// collectStats() scans every project database under the lcm home, so each fixture
// points LCM_HOME at its own.
describe("collectStats subagent share", () => {
  let home: string | undefined;

  afterEach(() => {
    delete process.env.LCM_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function withProjects(...projects: Session[][]): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "lcm-subagent-home-"));
    process.env.LCM_HOME = join(home, ".lossless-claude");
    for (const [i, sessions] of projects.entries()) {
      const dir = join(home!, ".lossless-claude", "projects", `p${i}`);
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(join(dir, "db.sqlite"));
      runLcmMigrations(db);
      const conversations = new ConversationStore(db);
      for (const { sessionId, ...attribution } of sessions) {
        const conversation = await conversations.getOrCreateConversation(sessionId, undefined, attribution);
        await conversations.createMessagesBulk([
          { conversationId: conversation.conversationId, seq: 0, role: "user", content: "Hello", tokenCount: 5 },
        ]);
      }
      db.close();
    }
  }

  it("counts conversations the search filter excludes by the agent- name, and the rest", async () => {
    await withProjects([
      { sessionId: "agent-a", parentSessionId: "human-1" },
      { sessionId: "agent-b", parentSessionId: "human-1" },
      { sessionId: "human-1" },
    ]);
    const stats = collectStats(createLcmPaths(process.env.LCM_HOME!));
    expect(stats.subagent).toEqual({ byName: 2, attributedNotByName: 0 });
    expect(stats.subagent.byName + (stats.conversations - stats.subagent.byName)).toBe(stats.conversations);
    expect(stats.conversations).toBe(3);
  });

  it("counts a sidecar-attributed conversation the name filter misses, across projects", async () => {
    await withProjects(
      [{ sessionId: "agent-a", parentSessionId: "human-1" }, { sessionId: "human-1" }],
      [{ sessionId: "renamed-c", parentSessionId: "human-2" }, { sessionId: "human-2" }],
    );
    const stats = collectStats(createLcmPaths(process.env.LCM_HOME!));
    expect(stats.subagent).toEqual({ byName: 1, attributedNotByName: 1 });
    expect(stats.conversations).toBe(4);
  });

  it("does not count a case-variant prefix as subagent-by-name, matching the search filter", async () => {
    await withProjects([
      { sessionId: "Agent-foo", parentSessionId: "human-1" },
      { sessionId: "human-1" },
    ]);
    const stats = collectStats(createLcmPaths(process.env.LCM_HOME!));
    expect(stats.subagent).toEqual({ byName: 0, attributedNotByName: 1 });
  });

  it("reports zeros when nothing is stored", () => {
    home = mkdtempSync(join(tmpdir(), "lcm-subagent-home-"));
    process.env.LCM_HOME = join(home, ".lossless-claude");
    const stats = collectStats(createLcmPaths(process.env.LCM_HOME));
    expect(stats.subagent).toEqual({ byName: 0, attributedNotByName: 0 });
  });
});
