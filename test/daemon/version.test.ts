import { describe, it, expect, afterEach } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_ID, fingerprintFile } from "../../src/daemon/version.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("BUILD_ID", () => {
  it("is a 16-char lowercase hex fingerprint", () => {
    expect(BUILD_ID).toBeDefined();
    expect(BUILD_ID).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is identical for byte-identical copies with different mtimes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lossless-buildid-"));
    tempDirs.push(dir);

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
    const dir = mkdtempSync(join(tmpdir(), "lossless-buildid-"));
    tempDirs.push(dir);

    const a = join(dir, "a.js");
    const b = join(dir, "b.js");
    writeFileSync(a, "export const answer = 42;\n");
    writeFileSync(b, "export const answer = 43;\n");

    expect(fingerprintFile(a)).not.toBe(fingerprintFile(b));
  });
});
