import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";

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
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-codex-"));
    tempDirs.push(tempDir);
    const path = join(tempDir, "rollout-2026-09-07-different-filename.jsonl");
    writeFileSync(path, [
      { type: "session_meta", payload: { id: "codex-meta-id", cwd: tempDir } },
      { type: "event_msg", payload: { type: "user_message", message: "duplicate notification" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
    ].map(line => JSON.stringify(line)).join("\n"));
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const post = (cwd: string) => fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "codex-meta-id", cwd, client: "codex", transcript_path: path }),
    });
    const wrong = await post(tmpdir());
    expect(await wrong.json()).toEqual({ ingested: 0, totalTokens: 0 });
    const response = await post(tempDir);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingested: 2, totalTokens: 3 });
    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      expect(db.prepare("SELECT role, content FROM messages ORDER BY seq").all().map(r => [r.role, r.content])).toEqual([["user", "hello"], ["assistant", "hi"]]);
      expect(db.prepare("SELECT session_id FROM conversations").get()?.session_id).toBe("codex-meta-id");
    } finally { db.close(); }
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
