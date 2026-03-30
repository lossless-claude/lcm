/**
 * Extended connection pool tests covering the untested `isLcmConnectionOpen` export.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  getLcmConnection,
  closeLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isLcmConnectionOpen", () => {
  it("returns false when no connection has been opened for the path", () => {
    const fakePath = "/tmp/this/path/was/never/opened.sqlite";
    expect(isLcmConnectionOpen(fakePath)).toBe(false);
  });

  it("returns true after a connection is opened", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);

    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it("returns false after the connection is fully closed (refs reach 0)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath); // open once, refs = 1
    closeLcmConnection(dbPath); // close once, refs = 0 → removed

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("remains open while refs > 0 after partial close", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath); // refs = 1
    getLcmConnection(dbPath); // refs = 2
    closeLcmConnection(dbPath); // refs = 1 — still open

    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });
});
