import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

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
});
