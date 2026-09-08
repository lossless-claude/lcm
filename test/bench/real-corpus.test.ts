import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBench } from "../../src/bench.js";

const file = process.env.LCM_REAL_BENCH_FILE;
const cwd = process.env.LCM_REAL_BENCH_PROJECT;

describe.skipIf(!file || !cwd)("reviewed real-corpus hit-rate gate", () => {
  it("beats grep with a useful hit rate and bounded empty rate and latency", async () => {
    expect(existsSync(file!)).toBe(true);
    const result = await runBench({ cwd: cwd!, benchFile: file, k: 5, json: true });
    expect(result.exitCode, result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.searchHitRate).toBeGreaterThanOrEqual(0.6);
    expect(report.searchHitRate).toBeGreaterThan(report.grepHitRate);
    expect(report.emptyRate).toBeLessThanOrEqual(0.1);
    expect(report.p95LatencyMs).toBeLessThanOrEqual(500);
  });
});
