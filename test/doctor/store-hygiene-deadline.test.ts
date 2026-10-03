import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { checkStaleProjectStores, CWD_CHECK_DEADLINE_MS, CWD_CHECK_CONCURRENCY } from "../../src/doctor/store-hygiene.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "lcm-cwd-deadline-")); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });

function records(cwds: string[]) {
  const paths = createLcmPaths(home);
  for (const [i, cwd] of cwds.entries()) {
    const dir = join(paths.projectsDir, i.toString(16).padStart(64, "0"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd }));
  }
  return paths;
}

it("reports a timed-out cwd separately from missing and stale paths", async () => {
  vi.useFakeTimers();
  const cwd = join(home, "unreachable");
  const stat = vi.fn(() => new Promise<void>(() => {}));
  const pending = checkStaleProjectStores(records([cwd]), true, stat);
  expect(pending).toBeInstanceOf(Promise);
  await vi.advanceTimersByTimeAsync(CWD_CHECK_DEADLINE_MS);
  const result = await pending;
  expect(result.status).toBe("warn");
  expect(result.message).toContain("0 stale project stores");
  expect(result.message).toContain("0 project directories with missing cwd");
  expect(result.message).toContain("1 project directories with unchecked cwd");
  expect(result.message).toContain(`${cwd}: not checked`);
});

it("bounds outstanding stats even after deadlines and leaves queued cwds unchecked", async () => {
  vi.useFakeTimers();
  const stat = vi.fn(() => new Promise<void>(() => {}));
  const projectCount = 12;
  const pending = checkStaleProjectStores(records(Array.from({ length: projectCount }, (_, i) => `/mount-${i}/cwd`)), false, stat, Array.from({ length: projectCount }, (_, i) => `/mount-${i}`));
  expect(pending).toBeInstanceOf(Promise);
  await vi.advanceTimersByTimeAsync(CWD_CHECK_DEADLINE_MS);
  expect(CWD_CHECK_CONCURRENCY).toBeLessThan(4);
  expect(stat).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(projectCount * CWD_CHECK_DEADLINE_MS);
  expect(stat).toHaveBeenCalledTimes(2);
  const result = await pending;
  expect(result.message).toContain("12 project directories with unchecked cwd");
  expect(result.message).toContain("0 project directories with missing cwd");
});

it("keeps reachable, missing and stale classifications while draining the queue", async () => {
  const present = join(home, "present");
  const temp = join(home, "missing");
  const ordinary = "/workspace/missing-checkout";
  const notDirectory = join(home, "file", "child");
  const cwds = [present, temp, ordinary, notDirectory, ...Array.from({ length: 5 }, (_, i) => `/workspace/present-${i}`)];
  const stat = vi.fn(async (cwd: string) => {
    if (cwd === temp || cwd === ordinary) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (cwd === notDirectory) throw Object.assign(new Error("not directory"), { code: "ENOTDIR" });
  });
  const pending = checkStaleProjectStores(records(cwds), false, stat);
  expect(pending).toBeInstanceOf(Promise);
  const result = await pending;
  expect(stat).toHaveBeenCalledTimes(9);
  expect(result.message).toContain("1 stale project stores");
  expect(result.message).toContain(temp);
  expect(result.message).toContain("3 project directories with missing cwd");
  expect(result.message).toContain("0 project directories with unchecked cwd");
});

it("quarantines a timed-out mount while checking other mounts and path-prefix siblings", async () => {
  vi.useFakeTimers();
  const cwds = ["/dead/first", "/dead/second", "/dead/third", "/dead/nested/healthy", "/dead-other/healthy", "/healthy/present", "/healthy/missing"];
  const stat = vi.fn(async (cwd: string) => {
    if (cwd === "/dead/first") await new Promise<void>(() => {});
    if (cwd === "/healthy/missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  const pending = checkStaleProjectStores(records(cwds), true, stat, ["/", "/dead", "/dead/nested", "/healthy"]);
  await vi.advanceTimersByTimeAsync(CWD_CHECK_DEADLINE_MS);
  const result = await pending;
  expect(stat.mock.calls.map(([cwd]) => cwd)).toEqual([
    "/dead/first", "/dead/nested/healthy", "/dead-other/healthy", "/healthy/present", "/healthy/missing",
  ]);
  expect(result.message).toContain("3 project directories with unchecked cwd");
  expect(result.message).toContain("1 project directories with missing cwd");
  expect(result.message).toContain("/dead/second: not checked");
  expect(result.message).toContain("/dead/third: not checked");
});

it.each(["0", "1", "invalid", "1.5"])("leaves a thread free with a one-thread pool setting (%s)", async poolSize => {
  vi.stubEnv("UV_THREADPOOL_SIZE", poolSize);
  vi.resetModules();
  const { checkStaleProjectStores: check } = await import("../../src/doctor/store-hygiene.js");
  const stat = vi.fn(async () => {});
  const result = await check(records(["/healthy/present"]), false, stat, ["/"]);
  expect(stat).not.toHaveBeenCalled();
  expect(result.message).toContain("1 project directories with unchecked cwd");
});
