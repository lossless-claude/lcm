import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDataDir: string;
let originalDataDir: string | undefined;

export function setup(): void {
  originalDataDir = process.env.LCM_DATA_DIR;
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
    if (originalDataDir === undefined) delete process.env.LCM_DATA_DIR;
    else process.env.LCM_DATA_DIR = originalDataDir;
  }
}
