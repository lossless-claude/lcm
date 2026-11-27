import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { childEnvWithHome, stubUserHome } from "./helpers/user-home.js";

// A test or child that gets HOME alone still resolves the test process's own home on Windows,
// where os.homedir() reads USERPROFILE (see test/helpers/user-home.ts, which moves both), so HOME
// is set nowhere else. A line that must set HOME alone says why: `// home-stub: <reason>`.
const HOME_ASSIGNMENTS = [
  /\bstubEnv\(\s*["'`]HOME["'`]/,
  /\.HOME\s*=(?!=)/,
  /\[\s*["'`]HOME["'`]\s*\]\s*=(?!=)/,
  /(?<![\w$])["'`]?HOME["'`]?\s*:/,
];
const ESCAPE = /\/\/ home-stub: \S/;
const OWNERS = new Set(["helpers/user-home.ts", "setup-env.ts", "home-stub-discipline.test.ts"]);
const testDir = fileURLToPath(new URL(".", import.meta.url));

/** 1-based numbers of the code lines in `source` that set HOME without the helper. */
function homeOnlyStubs(source: string): number[] {
  return source.split("\n").flatMap((line, index) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || ESCAPE.test(line)) return [];
    return HOME_ASSIGNMENTS.some((pattern) => pattern.test(line)) ? [index + 1] : [];
  });
}

/** Source files under `root`, as `/`-separated paths relative to it. */
function sourceFiles(root: string, dir = ""): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    // Other test files create and remove scratch trees here (.eval-*, .tool-corpus-*) while this
    // walks, and a directory removed mid-walk would fail it; none of them holds a test source.
    if (entry.name.startsWith(".")) return [];
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(root, path);
    return /\.(?:[cm]?ts|[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}

describe("home stub discipline", () => {
  it("moves os.homedir() for a child, whether its env extends process.env or starts from scratch, and leaves it no HOMEDRIVE or HOMEPATH", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-stub-home-"));
    const report = "process.stdout.write(JSON.stringify({ home: require('node:os').homedir(), drive: process.env.HOMEDRIVE ?? null, path: process.env.HOMEPATH ?? null }))";
    try {
      for (const base of [process.env, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }]) {
        const child = execFileSync(process.execPath, ["-e", report], { encoding: "utf8", env: childEnvWithHome(home, base) });
        expect(JSON.parse(child)).toEqual({ home, drive: null, path: null });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("moves os.homedir() in this process until the stubs are undone", () => {
    const before = homedir();
    const home = mkdtempSync(join(tmpdir(), "lcm-stub-home-"));
    try {
      stubUserHome(home);
      expect(homedir()).toBe(home);
      vi.unstubAllEnvs();
      expect(homedir()).toBe(before);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags each way of setting HOME alone and honours the escape comment", () => {
    const planted = [
      `vi.stubEnv("HOME", dir);`,
      `process.env.HOME = dir;`,
      `process.env["HOME"] = dir;`,
      `env.HOME = dir;`,
      `const env = { ...process.env, HOME: dir };`,
      `spawn(command, { env: { "HOME": dir } });`,
    ];
    expect(homeOnlyStubs(planted.join("\n"))).toEqual([1, 2, 3, 4, 5, 6]);
    const allowed = [
      `vi.stubEnv("LCM_HOME", dir);`,
      `const env = { ...childEnvWithHome(dir), LCM_HOME: dir };`,
      `if (process.env.HOME === dir) return;`,
      `// process.env.HOME = dir;`,
      ` * HOME: documented in a block comment`,
      `const env = { PATH, HOME: dir }; // home-stub: pins the POSIX-only fallback`,
    ];
    expect(homeOnlyStubs(allowed.join("\n"))).toEqual([]);
  });

  it("walks sources without entering dot-directories", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-walk-"));
    try {
      for (const path of ["a.test.ts", "notes.md", "nested/b.mjs", ".eval-pool-x/db/c.test.ts"]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "");
      }
      expect(sourceFiles(root).sort()).toEqual(["a.test.ts", "nested/b.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("test files set HOME only through test/helpers/user-home.ts", () => {
    const files = sourceFiles(testDir);
    // A walk that missed the tree would pass vacuously.
    expect(files).toEqual(expect.arrayContaining(["home-guard.test.ts", "e2e/flows/plugin-bundle.test.ts"]));
    const offenders = files
      .filter((path) => !OWNERS.has(path))
      .flatMap((path) => homeOnlyStubs(readFileSync(join(testDir, path), "utf8")).map((line) => `test/${path}:${line}`));
    expect(offenders).toEqual([]);
  });
});
