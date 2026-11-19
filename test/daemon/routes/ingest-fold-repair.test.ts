import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCapture } from "../../../src/capture.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { claudeProjectSlug, projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { expandFoldedRows } from "../../../src/import.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { ScrubEngine } from "../../../src/scrub.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";

const paths = createLcmPaths(lcmHome());
const dirs: string[] = [];
let daemon: DaemonInstance | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (daemon) await daemon.stop();
  daemon = undefined;
  for (const cwd of dirs.splice(0)) {
    rmSync(projectDir(cwd, paths), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("claude import --rebuild --expand-folds", () => {
  it("previews without writes, then backs up and restores stored placeholders through the daemon", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-fold-route-"));
    dirs.push(cwd);
    const stash = join(cwd, "stash");
    mkdirSync(stash);
    vi.stubEnv("TOKENADE_STASH_DIR", stash);
    const sessionId = "fold-repair-route";
    const claudeProjectsDir = join(homedir(), ".claude", "projects");
    const transcriptDir = join(claudeProjectsDir, claudeProjectSlug(cwd));
    mkdirSync(transcriptDir, { recursive: true });
    const path = join(transcriptDir, `${sessionId}.jsonl`);
    const output = `findable_original_output\n${"a long tool output line\n".repeat(120)}`;
    const hash = createHash("sha256").update(output).digest("hex").slice(0, 12);
    const placeholder = `[tokenade:elided 700 tokens on cold resume — recover: tokenade expand-ref ${hash}]`;
    writeFileSync(path, [
      { message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "a.txt" } }] } },
      { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: placeholder }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    mkdirSync(projectDir(cwd, paths), { recursive: true });
    const dbPath = projectDbPath(cwd, paths);
    const db = new DatabaseSync(dbPath);
    try {
      runLcmMigrations(db);
      // Captured while the stash lacked the original: the placeholder is what got stored.
      await new SessionCapture(db, "test-project", new ScrubEngine([], [])).captureTranscript({ sessionId, cwd, transcriptPath: path, client: "claude" });
    } finally { db.close(); }
    writeFileSync(join(stash, `${hash}.txt`), output);

    const options = { paths, cwd, _claudeProjectsDir: claudeProjectsDir };
    const preview = await expandFoldedRows(undefined, options);
    expect(preview.sessions).toEqual([expect.objectContaining({ plan: expect.objectContaining({ kind: "repairable", kept: 0 }) })]);
    expect(preview.sessions[0].plan.rows).toHaveLength(1);
    const before = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect((await new ConversationStore(before).getSessionMessages(sessionId)).map((row) => row.content)).toEqual(["Read", placeholder]);
    } finally { before.close(); }

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, join(cwd, "missing-token"));
    const applied = await expandFoldedRows(client, { ...options, apply: true });
    expect(applied.sessions[0]).toMatchObject({ repaired: 1, plan: { kind: "repairable" } });
    expect(existsSync(applied.sessions[0].backupPath!)).toBe(true);
    const read = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const store = new ConversationStore(read);
      const rows = await store.getSessionMessages(sessionId);
      expect(rows.map((row) => row.content)).toEqual(["Read", output]);
      expect(store.searchMessagesSync({ mode: "full_text", query: "findable_original_output" }).map((row) => row.messageId)).toContain(rows[1].messageId);
    } finally { read.close(); }
    expect((await expandFoldedRows(undefined, options)).sessions).toEqual([]);
  });
});
