import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { claudeTranscriptPath, projectDbPath } from "../../../src/daemon/project.js";
import { DatabaseSync } from "node:sqlite";

const tempDirs: string[] = [];

/** Writes transcript entries as Claude Code does, one JSON object per line. */
function writeTranscript(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const entry = (role: string, text: string) => ({ type: "message", message: { role, content: text } });

describe("POST /ingest discovers subagent transcripts (#434)", () => {
  let daemon: DaemonInstance | undefined;
  let tempHome: string;
  let cwd: string;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setUp(): { sessionId: string; parentTranscriptPath: string; subagentsDir: string } {
    tempHome = mkdtempSync(join(tmpdir(), "lossless-subagent-home-"));
    tempDirs.push(tempHome);
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "lossless-subagent-cwd-")));
    tempDirs.push(cwd);
    vi.stubEnv("HOME", tempHome);

    const sessionId = "parent-session";
    // claudeTranscriptPath reads HOME at call time via node:os homedir(), which
    // respects the stubbed env var above.
    const parentTranscriptPath = claudeTranscriptPath(cwd, sessionId)!;
    writeTranscript(parentTranscriptPath, [entry("user", "hi"), entry("assistant", "hello")]);
    const subagentsDir = join(dirname(parentTranscriptPath), sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    return { sessionId, parentTranscriptPath, subagentsDir };
  }

  async function ingest(sessionId: string): Promise<{ ingested: number; totalTokens: number }> {
    const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  it("ingests a dispatched subagent transcript without lcm import ever running", async () => {
    const { sessionId, subagentsDir } = setUp();
    const subagentPath = join(subagentsDir, "agent-sub1.jsonl");
    writeTranscript(subagentPath, [entry("user", "do the task"), entry("assistant", "done")]);
    writeFileSync(
      join(subagentsDir, "agent-sub1.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "run the task" }),
    );

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    await ingest(sessionId);

    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const conversations = db.prepare(
        "SELECT session_id, parent_session_id, subagent_type, subagent_desc FROM conversations ORDER BY session_id",
      ).all();
      expect(conversations).toEqual([
        { session_id: "agent-sub1", parent_session_id: sessionId, subagent_type: "general-purpose", subagent_desc: "run the task" },
        { session_id: sessionId, parent_session_id: null, subagent_type: null, subagent_desc: null },
      ]);
      const subMessages = db.prepare(
        "SELECT role, content FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.session_id = 'agent-sub1' ORDER BY seq",
      ).all();
      expect(subMessages).toEqual([{ role: "user", content: "do the task" }, { role: "assistant", content: "done" }]);
    } finally {
      db.close();
    }
  });

  it("does not duplicate subagent messages when the parent session is re-ingested", async () => {
    const { sessionId, subagentsDir } = setUp();
    const subagentPath = join(subagentsDir, "agent-sub1.jsonl");
    writeTranscript(subagentPath, [entry("user", "do the task"), entry("assistant", "done")]);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    await ingest(sessionId);
    await ingest(sessionId);

    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const count = db.prepare(
        "SELECT COUNT(*) as n FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.session_id = 'agent-sub1'",
      ).get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("ingests new subagent content added between two live /ingest calls", async () => {
    const { sessionId, subagentsDir } = setUp();
    const subagentPath = join(subagentsDir, "agent-sub1.jsonl");
    writeTranscript(subagentPath, [entry("user", "do the task")]);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    await ingest(sessionId);
    writeTranscript(subagentPath, [entry("user", "do the task"), entry("assistant", "done")]);
    await ingest(sessionId);

    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT role, content FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.session_id = 'agent-sub1' ORDER BY seq",
      ).all();
      expect(rows).toEqual([{ role: "user", content: "do the task" }, { role: "assistant", content: "done" }]);
    } finally {
      db.close();
    }
  });

  it("does not regress a session with no subagents", async () => {
    const { sessionId } = setUp();

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const result = await ingest(sessionId);
    expect(result.ingested).toBe(2);

    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const conversations = db.prepare("SELECT session_id FROM conversations").all();
      expect(conversations).toEqual([{ session_id: sessionId }]);
    } finally {
      db.close();
    }
  });

  it("ingests a subagent transcript with no .meta.json sidecar, attribution left null", async () => {
    const { sessionId, subagentsDir } = setUp();
    const subagentPath = join(subagentsDir, "agent-sub1.jsonl");
    writeTranscript(subagentPath, [entry("user", "do the task")]);
    // No sidecar written.

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    await ingest(sessionId);

    const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT parent_session_id, subagent_type, subagent_desc FROM conversations WHERE session_id = 'agent-sub1'",
      ).get();
      expect(row).toEqual({ parent_session_id: null, subagent_type: null, subagent_desc: null });
    } finally {
      db.close();
    }
  });
});
