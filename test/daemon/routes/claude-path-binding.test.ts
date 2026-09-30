import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCapture } from "../../../src/capture.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { invokeRoute } from "../../../src/daemon/routes/session-end.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { ScrubEngine } from "../../../src/scrub.js";

vi.mock("../../../src/daemon/project-language.js", () => ({
  scheduleProjectLanguageDetection: vi.fn().mockResolvedValue(undefined),
}));

describe("Claude transcript path binding", () => {
  let cwd: string;
  let paths: ReturnType<typeof createLcmPaths>;
  let ingest: ReturnType<typeof createIngestHandler>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lcm-path-binding-"));
    paths = createLcmPaths(join(cwd, "lcm"));
    ingest = createIngestHandler(loadDaemonConfig(join(cwd, "missing-config")), paths);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function transcript(relativePath: string): string {
    const path = join(cwd, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    // Imports identify Claude sessions by filename, even if an entry names an older id.
    writeFileSync(path, JSON.stringify({ sessionId: "original-id", message: { role: "user", content: "hello" } }) + "\n");
    return path;
  }

  it.each([{}, { source: "import" }, { source: "import", replay: true }, { source: "import", rebuild: true, backup: true }])(
    "rejects another session's file before creating project storage (%j)", async (flags) => {
      const path = transcript("other.jsonl");
      await expect(invokeRoute(ingest, { session_id: "requested", cwd, transcript_path: path, ...flags }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Claude transcript session id does not match request") });
      expect(existsSync(projectDir(cwd, paths))).toBe(false);
    },
  );

  it("validates the resolved filename rather than a symlink's name", async () => {
    const other = transcript("other.jsonl");
    const path = join(cwd, "requested.jsonl");
    symlinkSync(other, path);
    await expect(invokeRoute(ingest, { session_id: "requested", cwd, transcript_path: path }))
      .rejects.toMatchObject({ status: 400 });
    expect(existsSync(projectDir(cwd, paths))).toBe(false);
  });

  it.each([
    ["session", "session.jsonl", {}],
    ["session", "moved/session.jsonl", {}],
    ["session", "session/session.jsonl", { source: "import" }],
    ["renamed", "renamed.jsonl", { source: "import", replay: true }],
    ["agent-child", "parent/subagents/agent-child.jsonl", {}],
    ["child", "parent/subagents/agent-child.jsonl", {}],
    ["agent-workflow", "parent/subagents/workflows/run/agent-workflow.jsonl", { source: "import" }],
  ])("captures %s from %s (%j), including a resumed tail", async (sessionId, relativePath, flags) => {
    const path = transcript(relativePath);
    const body = { session_id: sessionId, cwd, transcript_path: path, ...flags };
    expect(await invokeRoute(ingest, body)).toMatchObject({ ingested: 1 });
    expect(await invokeRoute(ingest, body)).toMatchObject({ ingested: 0 });
    writeFileSync(path, JSON.stringify({ message: { role: "user", content: "hello" } }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: "resumed" } }) + "\n");
    expect(await invokeRoute(ingest, body)).toMatchObject({ ingested: 1 });
    const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
    try {
      expect(db.prepare("SELECT session_id FROM conversations").all()).toEqual([{ session_id: sessionId }]);
      expect(db.prepare("SELECT content FROM messages ORDER BY seq").all()).toEqual([{ content: "hello" }, { content: "resumed" }]);
    } finally { db.close(); }
  });

  it.each(["agent-child.jsonl", "parent/not-subagents/agent-child.jsonl", "parent/subagents/agent-other.jsonl"])(
    "refuses an unbound subagent path %s", async (relativePath) => {
      await expect(invokeRoute(ingest, { session_id: "child", cwd, transcript_path: transcript(relativePath) }))
        .rejects.toMatchObject({ status: 400 });
      expect(existsSync(projectDir(cwd, paths))).toBe(false);
    },
  );

  it.each(["captureTranscript", "rebuildTranscript"] as const)("%s refuses a mismatch without changing stored history", async (method) => {
    const db = new DatabaseSync(":memory:");
    try {
      runLcmMigrations(db);
      const capture = new SessionCapture(db, "project", new ScrubEngine([], []), paths);
      await capture.write({ sessionId: "requested", messages: [{ role: "user", content: "hello", tokenCount: 1 }] });
      const changes = db.prepare("SELECT total_changes() AS n").get();
      await expect(capture[method]({ sessionId: "requested", cwd, transcriptPath: transcript("other.jsonl"), source: "import" }))
        .rejects.toThrow("Claude transcript session id does not match request");
      expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    } finally { db.close(); }
  });
});
