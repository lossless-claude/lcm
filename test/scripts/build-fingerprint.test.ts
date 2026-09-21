import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFingerprint } from "../../scripts/write-build-id.mjs";

// The fingerprint decides whether the suite may run at all (test/setup-dist.ts), so it has to
// be sensitive to every input the build reads and to nothing else.

describe("sourceFingerprint", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "lcm-fingerprint-"));
    roots.push(root);
    writeFileSync(join(root, "tsconfig.json"), "{}");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  it("is stable across repeated reads of the same tree", () => {
    const root = tree({ "src/a.ts": "export const a = 1;\n" });
    expect(sourceFingerprint(root)).toBe(sourceFingerprint(root));
  });

  it("changes when a source file's bytes change", () => {
    const before = tree({ "src/a.ts": "export const a = 1;\n" });
    const after = tree({ "src/a.ts": "export const a = 2;\n" });
    expect(sourceFingerprint(after)).not.toBe(sourceFingerprint(before));
  });

  it("changes when a file is added or removed", () => {
    const one = tree({ "src/a.ts": "export const a = 1;\n" });
    const two = tree({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" });
    expect(sourceFingerprint(two)).not.toBe(sourceFingerprint(one));
  });

  it("changes when a file is renamed without changing its bytes", () => {
    const root = tree({ "src/a.ts": "export const a = 1;\n" });
    const first = sourceFingerprint(root);
    renameSync(join(root, "src/a.ts"), join(root, "src/b.ts"));
    expect(sourceFingerprint(root)).not.toBe(first);
  });

  it("covers every directory the build reads", () => {
    const base = tree({ "src/a.ts": "export const a = 1;\n", "bin/b.ts": "export const b = 1;\n" });
    const touched = tree({ "src/a.ts": "export const a = 1;\n", "bin/b.ts": "export const b = 2;\n" });
    expect(sourceFingerprint(touched)).not.toBe(sourceFingerprint(base));
  });
});
