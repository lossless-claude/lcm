import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCapture } from "../../../src/capture.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { claudeProjectSlug, projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { rebuildClaudeSessions } from "../../../src/import.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { ScrubEngine } from "../../../src/scrub.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";

/**
 * `lcm import --provider claude --rebuild`: the dry run classifies from the project database
 * alone, and `--yes` rebuilds each repairable session through the daemon's `/ingest`, inside
 * the project queue, after one backup of the project database.
 */

const paths = createLcmPaths(lcmHome());
const sessionId = "claude-rebuild-session";
type Turn = [role: "user" | "assistant", text: string];
const transcriptTurns: Turn[] = [
  ["user", "q1"], ["assistant", "r1"], ["user", "q2"], ["assistant", "r2"], ["user", "q3"], ["assistant", "r3"],
];
const damagedTurns: Turn[] = [
  ["user", "q1"], ["assistant", "r1"], ["assistant", "r2"], ["user", "q3"], ["user", "q3"], ["assistant", "r3"],
];

let cwd: string;
let transcriptPath: string;
let daemon: DaemonInstance | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "lcm-rebuild-project-"));
  // HOME is a directory of the test's own (test/setup-env.ts), so this is not a real Claude Code install.
  const claudeDir = join(homedir(), ".claude", "projects", claudeProjectSlug(cwd));
  mkdirSync(claudeDir, { recursive: true });
  transcriptPath = join(claudeDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, transcriptTurns.map(([role, text]) => JSON.stringify({ message: { role, content: text } })).join("\n") + "\n");
});
afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(projectDir(cwd, paths), { recursive: true, force: true });
});

/** The project database as an earlier lcm left it: a compacted session with a skipped and a repeated message. */
async function seedDamagedSession(): Promise<void> {
  mkdirSync(projectDir(cwd, paths), { recursive: true });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    runLcmMigrations(db);
    const written = await new SessionCapture(db, "proj", new ScrubEngine([], [])).write({
      sessionId, messages: damagedTurns.map(([role, content]) => ({ role, content, tokenCount: 1 })),
    });
    const store = new ConversationStore(db);
    const event = await store.createMessage({
      conversationId: written.conversationId, seq: (await store.getMaxSeq(written.conversationId)) + 1,
      role: "system", content: "LCM compaction leaf pass (normal): 100 -> 10", tokenCount: 1,
    });
    await store.createMessageParts(event.messageId, [{ sessionId, partType: "compaction", ordinal: 0 }]);
  } finally {
    db.close();
  }
}

function storedTurns(): Array<[string, string]> {
  const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
  try {
    return (db.prepare(
      `SELECT role, content FROM messages m WHERE NOT EXISTS (
         SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
       ORDER BY seq`,
    ).all() as Array<{ role: string; content: string }>).map(({ role, content }) => [role, content]);
  } finally {
    db.close();
  }
}

async function startDaemon(): Promise<{ client: DaemonClient; post: (body: object) => Promise<Response> }> {
  daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
  const url = `http://127.0.0.1:${daemon.address().port}`;
  return {
    client: new DaemonClient(url, join(cwd, "missing-daemon-token")),
    post: (body) => fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

describe("lcm import --provider claude --rebuild", () => {
  it("previews each compacted session without a daemon and without writing", async () => {
    await seedDamagedSession();
    const before = storedTurns();

    const run = await rebuildClaudeSessions(undefined, { paths, cwd });

    expect(run.sessions).toEqual([expect.objectContaining({
      cwd, plan: expect.objectContaining({ sessionId, kind: "repairable", gaps: 1, extras: 1 }),
    })]);
    expect(run.backups).toEqual([]);
    expect(storedTurns()).toEqual(before);
  });

  it("reports a compacted session with no transcript as unavailable", async () => {
    await seedDamagedSession();
    rmSync(transcriptPath);
    const run = await rebuildClaudeSessions(undefined, { paths, cwd });
    expect(run.sessions.map((s) => s.plan.kind)).toEqual(["unavailable"]);
  });

  it("with --yes: backs the project up once, rebuilds through the daemon, and a second run finds nothing", async () => {
    await seedDamagedSession();
    const { client } = await startDaemon();

    const run = await rebuildClaudeSessions(client, { paths, cwd, apply: true });

    expect(run.failedProjects).toEqual([]);
    expect(run.sessions).toEqual([expect.objectContaining({ rebuilt: true, ingested: 6 })]);
    expect(run.backups).toHaveLength(1);
    const backup = new DatabaseSync(run.backups[0], { readOnly: true });
    try {
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect((backup.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(7);
    } finally {
      backup.close();
    }
    expect(storedTurns()).toEqual(transcriptTurns);

    const again = await rebuildClaudeSessions(client, { paths, cwd, apply: true });
    expect(again.sessions).toEqual([]);
    expect(again.backups).toEqual([]);
  });

  it("serializes a rebuild with a live capture of the same session", async () => {
    await seedDamagedSession();
    writeFileSync(transcriptPath, `${JSON.stringify({ message: { role: "user", content: "q4" } })}\n`, { flag: "a" });
    const { post } = await startDaemon();

    const [rebuild, live] = await Promise.all([
      post({ session_id: sessionId, cwd, transcript_path: transcriptPath, source: "import", rebuild: true }),
      post({ session_id: sessionId, cwd, transcript_path: transcriptPath }),
    ]);

    expect(rebuild.status).toBe(200);
    // Queued first, the live capture meets the damaged history and stalls; queued second, it finds nothing new.
    expect([200, 400]).toContain(live.status);
    expect(storedTurns()).toEqual([...transcriptTurns, ["user", "q4"]]);
  });

  it("refuses a rebuild request for another harness or with messages supplied", async () => {
    await seedDamagedSession();
    const { post } = await startDaemon();
    expect((await post({ session_id: sessionId, cwd, transcript_path: transcriptPath, rebuild: true, client: "codex" })).status).toBe(400);
    expect((await post({ session_id: sessionId, cwd, rebuild: true, messages: [{ role: "user", content: "x", tokenCount: 1 }] })).status).toBe(400);
    expect((await post({ session_id: sessionId, cwd, rebuild: true, messages: [] })).status).toBe(400);
    expect(existsSync(projectDbPath(cwd, paths))).toBe(true);
    expect(storedTurns()).toEqual(damagedTurns);
  });
});
