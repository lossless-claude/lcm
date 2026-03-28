import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { getLcmConnection, closeLcmConnection, getPoolStats } from "../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(() => {
  // Close all connections and clean up
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getPoolStats", () => {
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
