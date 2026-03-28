import { describe, it, expect } from "vitest";
import { buildOrientationPrompt, LCM_MD_CONTENT } from "../../src/daemon/orientation.js";

describe("buildOrientationPrompt", () => {
  it("returns empty string — guidance now lives in ~/.claude/lcm.md", () => {
    expect(buildOrientationPrompt()).toBe("");
  });
});

describe("LCM_MD_CONTENT", () => {
  it("mentions all four MCP tools", () => {
    expect(LCM_MD_CONTENT).toContain("lcm_grep");
    expect(LCM_MD_CONTENT).toContain("lcm_expand");
    expect(LCM_MD_CONTENT).toContain("lcm_describe");
    expect(LCM_MD_CONTENT).toContain("lcm_search");
  });
  it("instructs not to store manually", () => {
    expect(LCM_MD_CONTENT).toContain("Do NOT store manually");
  });
  it("includes retrieval chain example", () => {
    expect(LCM_MD_CONTENT).toContain("lcm_search");
    expect(LCM_MD_CONTENT).toContain("lcm_expand");
  });
});
