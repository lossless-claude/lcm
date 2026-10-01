import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createLcmPaths } from "../src/lcm-paths.js";
import { lcmHome } from "../src/lcm-home.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureHome(): string {
  const root = mkdtempSync(join(resolve("."), "test-home-guard-"));
  roots.push(root);
  return root;
}

it("refuses the real lcm home even when LCM_HOME or HOME selects it", () => {
  // A stand-in for the protected home, entirely inside the harness's sandbox.
  const userHome = fixtureHome();
  const realHome = join(userHome, ".lossless-claude");
  vi.stubEnv("LCM_TEST_REAL_HOME", realHome);
  expect(() => lcmHome({ LCM_HOME: realHome })).toThrow("refused the real lcm home");
  expect(() => createLcmPaths(realHome)).toThrow("refused the real lcm home");
  expect(() => createLcmPaths(join(realHome, "..", ".lossless-claude"))).toThrow("refused the real lcm home");
  const script = `import { lcmHome } from './dist/src/lcm-home.js';
    import { createLcmPaths } from './dist/src/lcm-paths.js';
    createLcmPaths(lcmHome());`;
  for (const override of [realHome, ""]) {
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolve("."), env: { ...process.env, HOME: userHome, LCM_HOME: override }, stdio: "pipe",
    })).toThrow("refused the real lcm home");
  }
});

it("refuses a symlink to the protected home and allows an isolated home", () => {
  const userHome = fixtureHome();
  const realHome = join(userHome, ".lossless-claude");
  mkdirSync(realHome, { recursive: true });
  const alias = join(userHome, "alias");
  symlinkSync(realHome, alias);
  vi.stubEnv("LCM_TEST_REAL_HOME", realHome);
  expect(() => createLcmPaths(alias)).toThrow("refused the real lcm home");
  expect(createLcmPaths(process.env.LCM_HOME!).home).toBe(process.env.LCM_HOME);
});
