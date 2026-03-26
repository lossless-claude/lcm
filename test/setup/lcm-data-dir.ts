import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDataDir: string;

export function setup(): void {
  testDataDir = mkdtempSync(join(tmpdir(), "lcm-test-data-"));
  process.env.LCM_DATA_DIR = testDataDir;
}

export function teardown(): void {
  if (testDataDir) {
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[lcm-data-dir] failed to clean up test data dir ${testDataDir}:`, err);
    }
    delete process.env.LCM_DATA_DIR;
  }
}
