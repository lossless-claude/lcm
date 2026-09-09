import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { enqueue } from "../../../src/daemon/project-queue.js";
import { importSessions } from "../../../src/import.js";

const tempDirs: string[] = [];

describe("POST /ingest", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses Codex rollout responses server-side and rejects a mismatched project", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "lossless-ingest-codex-"));
    tempDirs.push(rootDir);
    const tempDir = join(rootDir, "project");
    mkdirSync(tempDir);
    const path = join(tempDir, "rollout-2026-09-07-different-filename.jsonl");
    writeFileSync(path, [
      { type: "session_meta", payload: { id: "codex-meta-id", cwd: tempDir } },
      { type: "event_msg", payload: { type: "user_message", message: "duplicate notification" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const post = (cwd: string, sessionId = "codex-meta-id", transcriptPath = path) => fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd, client: "codex", transcript_path: transcriptPath }),
    });
    const wrong = await post(rootDir);
    const wrongBody = await wrong.json();
    expect(wrong.status, JSON.stringify(wrongBody)).toBe(400);
    expect(wrongBody).toEqual({ error: "Codex transcript cwd does not match requested project" });
    const wrongSession = await post(tempDir, "different-session-id");
    expect(wrongSession.status).toBe(400);
    expect(await wrongSession.json()).toEqual({ error: "Codex transcript session id does not match request" });
    const missing = await post(tempDir, "codex-meta-id", join(tempDir, "missing.jsonl"));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Codex transcript is unreadable" });
    const outsideDir = mkdtempSync(join(tmpdir(), "lossless-ingest-codex-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = join(outsideDir, "rollout.jsonl");
    writeFileSync(outsidePath, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-meta-id", cwd: tempDir } })}\n`);
    const disallowed = await post(tempDir, "codex-meta-id", outsidePath);
    expect(disallowed.status).toBe(400);
    expect(await disallowed.json()).toEqual({ error: "Codex transcript path is not allowed" });
    const response = await post(tempDir);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingested: 2, totalTokens: 3 });
    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      expect(db.prepare("SELECT role, content FROM messages ORDER BY seq").all().map(r => [r.role, r.content])).toEqual([["user", "hello"], ["assistant", "hi"]]);
      expect(db.prepare("SELECT session_id FROM conversations").get()?.session_id).toBe("codex-meta-id");
    } finally { db.close(); }
  });

  it("recovers a deferred Codex tail after restart and deduplicates an overlapping import", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-codex-delta-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, "codex-home");
    const transcriptDir = join(codexHome, "sessions", "2026", "09", "08");
    mkdirSync(transcriptDir, { recursive: true });
    const path = join(transcriptDir, "rollout-codex-delta.jsonl");
    const sessionId = "codex-delta-id";
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: tempDir } });
    const message = (role: "user" | "assistant", text: string) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      },
    });
    const first = message("user", "first complete message");
    const second = message("assistant", "tail recovered by import");
    writeFileSync(path, `${meta}\n${first}\n${second.slice(0, -8)}`);

    const startDaemon = async () => createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    daemon = await startDaemon();
    const postLive = () => fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: tempDir, client: "codex", transcript_path: path }),
    });

    expect(await (await postLive()).json()).toEqual({ ingested: 1, totalTokens: 6 });
    expect(await (await postLive()).json()).toEqual({ ingested: 0, totalTokens: 0 });
    const invalidImport = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        client: "codex",
        source: "import",
        transcript_path: path,
      }),
    });
    expect(invalidImport.status).toBe(400);
    const invalidOffset = Buffer.byteLength(`${meta}\n${first}\n`, "utf8");
    expect(await invalidImport.json()).toEqual({ error: `Invalid Codex transcript JSONL at byte offset ${invalidOffset}` });
    writeFileSync(path, `${meta}\n${first}\n${second.slice(0, -8)}\n`);
    const invalidLive = await postLive();
    expect(invalidLive.status).toBe(400);
    expect(await invalidLive.json()).toEqual({ error: `Invalid Codex transcript JSONL at byte offset ${invalidOffset}` });

    await daemon.stop();
    daemon = undefined;
    writeFileSync(path, `${meta}\n${first}\n${second}`);
    daemon = await startDaemon();

    // A live capture still defers the valid but non-newline-terminated tail.
    expect(await (await postLive()).json()).toEqual({ ingested: 0, totalTokens: 0 });

    const db = new DatabaseSync(projectDbPath(tempDir));
    db.prepare(
      "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count",
    ).run(sessionId, 1);
    db.close();

    const client = new DaemonClient(
      `http://127.0.0.1:${daemon.address().port}`,
      join(tempDir, "missing-daemon-token"),
    );
    const imported = await importSessions(client, {
      provider: "codex",
      cwd: tempDir,
      _codexDir: codexHome,
    });
    expect(imported.imported).toBe(1);
    expect(imported.totalMessages).toBe(1);

    const repeated = await importSessions(client, {
      provider: "codex",
      cwd: tempDir,
      _codexDir: codexHome,
    });
    expect(repeated.imported).toBe(0);
    expect(repeated.skippedEmpty).toBe(1);

    const third = message("user", "concurrent tail");
    writeFileSync(path, `${meta}\n${first}\n${second}\n${third}\n`);
    let releaseQueue!: () => void;
    let markQueueStarted!: () => void;
    const queueHold = new Promise<void>(resolve => { releaseQueue = resolve; });
    const queueStarted = new Promise<void>(resolve => { markQueueStarted = resolve; });
    const blocker = enqueue(projectId(tempDir), async () => {
      markQueueStarted();
      await queueHold;
    });
    await queueStarted;
    const concurrentPromise = Promise.all([postLive(), postLive()]);
    try {
      const state = await Promise.race([
        concurrentPromise.then(() => "settled" as const),
        new Promise<"waiting">(resolve => setTimeout(() => resolve("waiting"), 50)),
      ]);
      expect(state).toBe("waiting");
    } finally {
      releaseQueue();
      await blocker;
    }
    const concurrent = await concurrentPromise;
    const concurrentBodies = await Promise.all(concurrent.map(response => response.json()));
    expect(concurrentBodies.map(body => body.ingested).sort()).toEqual([0, 1]);
    expect(await (await postLive()).json()).toEqual({ ingested: 0, totalTokens: 0 });

    const verifyDb = new DatabaseSync(projectDbPath(tempDir));
    try {
      expect(verifyDb.prepare("SELECT role, content FROM messages ORDER BY seq").all()).toEqual([
        { role: "user", content: "first complete message" },
        { role: "assistant", content: "tail recovered by import" },
        { role: "user", content: "concurrent tail" },
      ]);
    } finally {
      verifyDb.close();
    }
  });

  it("keeps filename-derived identity for legacy Codex imports without a metadata id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-codex-legacy-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, "codex-home");
    const archivedDir = join(codexHome, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    const transcriptPath = join(archivedDir, "legacy-session.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "session_meta", payload: { cwd: tempDir } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "legacy imported message" }],
        },
      }),
    ].join("\n"));

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const liveResponse = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "legacy-session",
        cwd: tempDir,
        client: "codex",
        transcript_path: transcriptPath,
      }),
    });
    expect(liveResponse.status).toBe(400);
    expect(await liveResponse.json()).toEqual({ error: "Codex transcript session id does not match request" });

    const client = new DaemonClient(
      `http://127.0.0.1:${daemon.address().port}`,
      join(tempDir, "missing-daemon-token"),
    );
    const result = await importSessions(client, {
      provider: "codex",
      cwd: tempDir,
      _codexDir: codexHome,
    });
    expect(result.totalMessages).toBe(1);

    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      expect(db.prepare(
        "SELECT c.session_id, m.content FROM conversations c JOIN messages m ON m.conversation_id = c.conversation_id",
      ).get()).toEqual({ session_id: "legacy-session", content: "legacy imported message" });
    } finally {
      db.close();
    }
  });

  it("accepts messages[] as an alternative to transcript_path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "hello", tokenCount: 1 },
          { role: "assistant", content: "hi", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 2 });
  });

  it("accepts tool messages in structured ingestion mode", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-tool-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-tool",
        cwd: tempDir,
        messages: [
          { role: "user", content: "run rg", tokenCount: 2 },
          { role: "assistant", content: "Tool call shell: rg --files", tokenCount: 6 },
          { role: "tool", content: "README.md", tokenCount: 2 },
          { role: "assistant", content: "Done", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 4, totalTokens: 11 });
  });

  it("prefers messages[] over transcript_path when both are present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-both-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-2",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
        messages: [
          { role: "user", content: "preferred", tokenCount: 2 },
          { role: "assistant", content: "path", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 3 });
  });

  it("scrubs secrets from message content before SQLite write", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-scrub-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_PROJECT_SECRET"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "scrub-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "token=MY_PROJECT_SECRET", tokenCount: 5 },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // Verify the stored content was scrubbed
    const db = new DatabaseSync(projectDbPath(tempDir));
    let row: { content: string } | undefined;
    try {
      row = db.prepare("SELECT content FROM messages LIMIT 1").get() as { content: string } | undefined;
    } finally {
      db.close();
    }
    expect(row?.content).toContain("[REDACTED]");
    expect(row?.content).not.toContain("MY_PROJECT_SECRET");
  });

  it("increments redaction_stats per category when content contains secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-redact-stats-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_GLOBAL_TOKEN"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "redact-stats-1",
        cwd: tempDir,
        messages: [
          {
            role: "user",
            // ghp_ + 36 alphanumeric chars → matches built-in GitHub token pattern
            // MY_GLOBAL_TOKEN → matches the global pattern above
            content: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and MY_GLOBAL_TOKEN",
            tokenCount: 10,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      // ghp_ token is matched by gitleaks github-pat pattern (gitleaks takes priority over native)
      expect(byCategory["gitleaks"]).toBeGreaterThan(0);
      expect(byCategory["global"]).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("replay ingests the transcript tail of a session already in session_ingest_log", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const url = `http://127.0.0.1:${daemon.address().port}/ingest`;
    const post = (body: Record<string, unknown>) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const first = [{ role: "user", content: "hello", tokenCount: 1 }];
    const grown = [...first, { role: "assistant", content: "hi", tokenCount: 1 }];

    await post({ session_id: "done-sess", cwd: tempDir, messages: first });
    const db = new DatabaseSync(projectDbPath(tempDir));
    db.prepare("INSERT INTO session_ingest_log (session_id, message_count) VALUES ('done-sess', 1)").run();
    db.close();

    // The ordinary path trusts the completion log and skips the grown transcript.
    expect(await (await post({ session_id: "done-sess", cwd: tempDir, messages: grown })).json()).toEqual({ ingested: 0, totalTokens: 0 });
    // A replay re-reads it and ingests only the tail.
    expect(await (await post({ session_id: "done-sess", cwd: tempDir, messages: grown, replay: true })).json()).toEqual({ ingested: 1, totalTokens: 2 });
    // Idempotent: nothing new on the next replay pass.
    expect(await (await post({ session_id: "done-sess", cwd: tempDir, messages: grown, replay: true })).json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("returns ingested=0 when transcript_path is missing and messages[] is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-missing-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-3",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });
});
