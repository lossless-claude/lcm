import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectMetaPath } from "../../src/daemon/project.js";
import { pivotLanguagesFor, pivotQueryApplies, pivotQueryHint } from "../../src/search/pivot-language.js";
import { buildMemoryContext } from "../../src/hooks/memory-context.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectWithLanguage(language?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-pivot-lang-"));
  tempDirs.push(dir);
  const meta = projectMetaPath(dir);
  mkdirSync(dirname(meta), { recursive: true });
  if (language) writeFileSync(meta, JSON.stringify({ language }));
  return dir;
}

describe("pivot languages", () => {
  it("reads the author language recorded for the project", () => {
    expect(pivotLanguagesFor(projectWithLanguage("pt-BR"), "en")).toEqual({ authorLanguage: "pt-BR", pivotLanguage: "en" });
    expect(pivotLanguagesFor(projectWithLanguage(), "en")).toEqual({ authorLanguage: undefined, pivotLanguage: "en" });
  });

  it("applies only when the two languages differ, regardless of region", () => {
    expect(pivotQueryApplies({ authorLanguage: "pt-BR", pivotLanguage: "en" })).toBe(true);
    expect(pivotQueryApplies({ authorLanguage: "en-GB", pivotLanguage: "en" })).toBe(false);
    expect(pivotQueryApplies({ pivotLanguage: "en" })).toBe(false);
  });

  it("hints only when a translation would help", () => {
    expect(pivotQueryHint({ authorLanguage: "pt-BR", pivotLanguage: "en" })).toContain("pivotQuery");
    expect(pivotQueryHint({ authorLanguage: "en", pivotLanguage: "en" })).toBeUndefined();
  });

  it("carries the hint inside the memory-context block", () => {
    const hint = pivotQueryHint({ authorLanguage: "pt-BR", pivotLanguage: "en" });
    expect(buildMemoryContext(["a past decision"], ["m1"], hint)).toContain(hint!);
    expect(buildMemoryContext(["a past decision"], ["m1"])).not.toContain("pivotQuery");
  });
});
