import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { getLcmConnection, closeLcmConnection, getPoolStats, isLcmConnectionOpen } from "../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(() => {
  // Close all connections and clean up
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getPoolStats", () => {
  it("opens a read-only handle without changing database bytes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");
    const writable = getLcmConnection(dbPath);
    writable.exec("CREATE TABLE value (n INTEGER); INSERT INTO value VALUES (1)");
    closeLcmConnection(dbPath);
    const before = readFileSync(dbPath);

    expect(getLcmConnection(dbPath, { readOnly: true }).prepare("SELECT n FROM value").get()).toEqual({ n: 1 });
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    closeLcmConnection(dbPath, { readOnly: true });
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it("keeps read-only and writable handles independent and closes the requested mode", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");
    const writable = getLcmConnection(dbPath);
    writable.exec("CREATE TABLE value (n INTEGER)");
    const readonly = getLcmConnection(dbPath, { readOnly: true });

    expect(getPoolStats()).toMatchObject({ totalConnections: 2, activeConnections: 2 });
    closeLcmConnection(dbPath, { readOnly: true });
    expect(getPoolStats()).toMatchObject({ totalConnections: 1, connections: [expect.objectContaining({ path: dbPath, refs: 1 })] });
    writable.exec("INSERT INTO value VALUES (2)");
    expect(writable.prepare("SELECT n FROM value").get()).toEqual({ n: 2 });
    expect(() => readonly.prepare("SELECT 1").get()).toThrow();

    const readonlyForAll = getLcmConnection(dbPath, { readOnly: true });
    expect(getPoolStats()).toMatchObject({ totalConnections: 2, activeConnections: 2 });
    closeLcmConnection();
    expect(getPoolStats()).toMatchObject({ totalConnections: 0, activeConnections: 0, idleConnections: 0 });
    expect(() => writable.prepare("SELECT 1").get()).toThrow();
    expect(() => readonlyForAll.prepare("SELECT 1").get()).toThrow();
  });

  it("returns empty pool when no connections are open", () => {
    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(0);
    expect(stats.activeConnections).toBe(0);
    expect(stats.idleConnections).toBe(0);
    expect(stats.connections).toHaveLength(0);
  });

  it("reports an active connection when refs > 0", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);
    expect(stats.idleConnections).toBe(0);
    expect(stats.connections[0].path).toBe(dbPath);
    expect(stats.connections[0].refs).toBe(1);
    expect(stats.connections[0].status).toBe("active");
  });

  it("increments refs for repeated opens of the same path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);
    getLcmConnection(dbPath);

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);
    expect(stats.connections[0].refs).toBe(2);
  });

  it("tracks multiple distinct connections", () => {
    const tempDir1 = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    const tempDir2 = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir1, tempDir2);

    getLcmConnection(join(tempDir1, "db.sqlite"));
    getLcmConnection(join(tempDir2, "db.sqlite"));

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(2);
    expect(stats.activeConnections).toBe(2);
    expect(stats.idleConnections).toBe(0);
  });

  it("reduces refs after close and marks idle at refs=0", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);
    getLcmConnection(dbPath); // refs = 2

    closeLcmConnection(dbPath); // refs = 1

    const stats = getPoolStats();
    // refs=1 still means active
    expect(stats.connections[0].refs).toBe(1);
    expect(stats.connections[0].status).toBe("active");

    closeLcmConnection(dbPath); // refs = 0 → removed from pool

    const stats2 = getPoolStats();
    expect(stats2.totalConnections).toBe(0);
  });

  it("returns correct shape with all required fields", () => {
    const stats = getPoolStats();
    expect(stats).toHaveProperty("totalConnections");
    expect(stats).toHaveProperty("activeConnections");
    expect(stats).toHaveProperty("idleConnections");
    expect(stats).toHaveProperty("connections");
    expect(Array.isArray(stats.connections)).toBe(true);
  });
});
