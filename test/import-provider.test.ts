import { describe, expect, it } from "vitest";
import { resolveImportProvider } from "../src/import.js";

// The CLI default is also pinned end to end by the golden snapshot k03 (`lcm import --dry-run`).
describe("resolveImportProvider", () => {
  it("selects every source when no flag is given", () => {
    expect(resolveImportProvider()).toBe("all");
    expect(resolveImportProvider({})).toBe("all");
  });

  it.each(["claude", "codex", "omp", "all"])("accepts --provider %s", (name) => {
    expect(resolveImportProvider({ provider: name })).toBe(name);
  });

  it("treats --codex and --omp as aliases", () => {
    expect(resolveImportProvider({ codex: true })).toBe("codex");
    expect(resolveImportProvider({ omp: true })).toBe("omp");
    expect(resolveImportProvider({ codex: true, provider: "codex" })).toBe("codex");
  });

  it("rejects conflicting and unknown sources", () => {
    expect(() => resolveImportProvider({ codex: true, omp: true })).toThrow("--codex cannot be combined with --omp");
    expect(() => resolveImportProvider({ omp: true, provider: "claude" })).toThrow("--omp cannot be combined with a different --provider");
    expect(() => resolveImportProvider({ provider: "cursor" })).toThrow('Unknown provider "cursor"');
  });
});
