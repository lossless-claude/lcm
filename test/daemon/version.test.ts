import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUILD_ID, fingerprintFile, readBuildIdFile } from "../../src/daemon/version.js";

const HEX16 = /^[0-9a-f]{16}$/;
const scriptPath = fileURLToPath(new URL("../../scripts/write-build-id.mjs", import.meta.url));

const tempDirs: string[] = [];

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lossless-buildid-"));
  tempDirs.push(dir);
  return dir;
}

function runBuildIdScript(distDir: string): string {
  return execFileSync(process.execPath, [scriptPath, distDir], { encoding: "utf-8" }).trim();
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("BUILD_ID", () => {
  it("is a 16-char lowercase hex fingerprint", () => {
    expect(BUILD_ID).toBeDefined();
    expect(BUILD_ID).toMatch(HEX16);
  });
});

describe("PKG_VERSION", () => {
  it.each(["src/daemon", "dist/src/daemon"])("reads LCM's own package in a nested %s layout", (layout) => {
    const parent = newTempDir();
    const checkout = join(parent, "lcm");
    const moduleDir = join(checkout, layout);
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "enclosing-project", version: "99.0.0" }));
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@lossless-claude/lcm", version: "1.2.3" }));
    const modulePath = join(moduleDir, "version.mjs");
    copyFileSync(resolve("dist/src/daemon/version.js"), modulePath);
    const result = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { PKG_VERSION } from ${JSON.stringify(pathToFileURL(modulePath).href)}; console.log(PKG_VERSION);`,
    ], { encoding: "utf8" });
    expect(result.trim()).toBe("1.2.3");
  });
});

describe("fingerprintFile", () => {
  it("is identical for byte-identical copies with different mtimes", () => {
    const dir = newTempDir();
    const original = join(dir, "module.js");
    const copy = join(dir, "module-copy.js");
    writeFileSync(original, "export const answer = 42;\n");
    copyFileSync(original, copy);

    // Simulate a copy tool that does not preserve mtimes exactly.
    const shifted = new Date(Date.now() - 60_000);
    utimesSync(copy, shifted, shifted);
    expect(statSync(copy).mtimeMs).not.toBe(statSync(original).mtimeMs);

    expect(fingerprintFile(copy)).toBe(fingerprintFile(original));
  });

  it("differs when content differs", () => {
    const dir = newTempDir();
    const a = join(dir, "a.js");
    const b = join(dir, "b.js");
    writeFileSync(a, "export const answer = 42;\n");
    writeFileSync(b, "export const answer = 43;\n");

    expect(fingerprintFile(a)).not.toBe(fingerprintFile(b));
  });
});

describe("readBuildIdFile", () => {
  it("reads a well-formed id from the first candidate that has one", () => {
    const empty = newTempDir();
    const dir = newTempDir();
    writeFileSync(join(dir, "BUILD_ID"), "0123456789abcdef");

    expect(readBuildIdFile([empty, dir])).toBe("0123456789abcdef");
  });

  it("tolerates a trailing newline", () => {
    const dir = newTempDir();
    writeFileSync(join(dir, "BUILD_ID"), "0123456789abcdef\n");
    expect(readBuildIdFile([dir])).toBe("0123456789abcdef");
  });

  it("returns undefined when no file exists or the content is malformed", () => {
    const missing = newTempDir();
    const bad = newTempDir();
    writeFileSync(join(bad, "BUILD_ID"), "not-a-fingerprint");

    expect(readBuildIdFile([missing])).toBeUndefined();
    expect(readBuildIdFile([bad])).toBeUndefined();
    expect(readBuildIdFile([])).toBeUndefined();
  });
});

describe("write-build-id script", () => {
  it("writes a 16-char hex id that covers every emitted js file", () => {
    const dist = newTempDir();
    mkdirSync(join(dist, "src", "daemon"), { recursive: true });
    writeFileSync(join(dist, "src", "daemon", "server.js"), "export const a = 1;\n");
    writeFileSync(join(dist, "src", "daemon", "version.js"), "export const b = 2;\n");

    const first = runBuildIdScript(dist);
    expect(first).toMatch(HEX16);
    expect(readBuildIdFile([dist])).toBe(first);

    // Stable when nothing changed.
    expect(runBuildIdScript(dist)).toBe(first);

    // Changes when an unrelated emitted file changes.
    writeFileSync(join(dist, "src", "daemon", "server.js"), "export const a = 99;\n");
    const second = runBuildIdScript(dist);
    expect(second).toMatch(HEX16);
    expect(second).not.toBe(first);
  });

  it("changes when a file is renamed but its bytes are not", () => {
    const dist = newTempDir();
    writeFileSync(join(dist, "one.js"), "export const a = 1;\n");
    const before = runBuildIdScript(dist);

    rmSync(join(dist, "one.js"));
    writeFileSync(join(dist, "two.js"), "export const a = 1;\n");
    expect(runBuildIdScript(dist)).not.toBe(before);
  });
});
