import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /store", () => {
  it("stores to SQLite promoted table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "We decided to use React",
          tags: ["decision"],
          cwd: tempDir,
        }),
      });
      const data = await res.json() as { stored: boolean; id: string };
      expect(res.status).toBe(200);
      expect(data.stored).toBe(true);
      expect(data.id).toBeTruthy();
    } finally {
      await daemon.stop();
    }
  });

  it("returns 400 when text is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-err-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it("returns 400 when cwd is missing", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it("scrubs secrets before inserting into the promoted table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-scrub-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const secretKey = "sk-ant-api03-" + "a".repeat(40);
    const text = `My API key is ${secretKey} and should be scrubbed`;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, cwd: tempDir }),
      });
      expect(res.status).toBe(200);

      // Read back directly from the SQLite promoted table
      const dbPath = projectDbPath(tempDir);
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        const rows = db.prepare("SELECT content FROM promoted ORDER BY created_at DESC LIMIT 1").all() as Array<{ content: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toContain("[REDACTED]");
        expect(rows[0].content).not.toContain("sk-ant-api03");
      } finally {
        db.close();
      }
    } finally {
      await daemon.stop();
    }
  });
});
