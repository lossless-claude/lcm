import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LCM_MD_CONTENT, LEARNING_INSTRUCTION, RULES_CLI, RULES_MCP,
  STORE_TOOL_DESCRIPTION, STORE_TOOL_TAGS_DESCRIPTION, STORE_TYPES, TAG_PREFIXES,
} from "../src/guidance.js";

const RESERVED = ["signal:memory_used", "signal:memory_vote", "memory_id:<id>", "vote:+1", "vote:-1"];

const surfaces = [
  { name: "lcm.md", text: LCM_MD_CONTENT, store: "lcm_store", reserved: false },
  { name: "learning instruction", text: LEARNING_INSTRUCTION, store: "lcm_store", reserved: true },
  { name: "CLI rules", text: RULES_CLI, store: "lcm store", reserved: true },
  { name: "MCP rules", text: RULES_MCP, store: "lcm_store", reserved: true },
  { name: "lcm_store definition", text: `${STORE_TOOL_DESCRIPTION}\n${STORE_TOOL_TAGS_DESCRIPTION}`, store: "lcm_search", reserved: true },
];

describe("every guidance surface states the same rule", () => {
  for (const s of surfaces) {
    it(`${s.name} names every store type`, () => {
      for (const t of STORE_TYPES) expect(s.text).toContain(t.value);
    });

    it(`${s.name} names the tag prefixes a store needs`, () => {
      for (const p of ["type:", "project:", "scope:", "source:", "priority:"]) expect(s.text).toContain(p);
    });

    it(`${s.name} uses its own tool naming`, () => {
      expect(s.text).toContain(s.store);
    });

    it(`${s.name} ${s.reserved ? "carries" : "leaves out"} the reserved tags`, () => {
      for (const r of RESERVED) {
        if (s.reserved) expect(s.text).toContain(r);
        else expect(s.text).not.toContain(r);
      }
    });
  }

  it("the CLI rules never name an MCP tool, and the MCP surfaces never name a CLI command", () => {
    expect(RULES_CLI).not.toMatch(/lcm_\w+/);
    for (const text of [RULES_MCP, LCM_MD_CONTENT, LEARNING_INSTRUCTION]) expect(text).not.toMatch(/`lcm [a-z]/);
  });

  it("the surfaces that say when to search say it the same way", () => {
    const trigger = "Search memory before a code task in this project";
    for (const text of [LCM_MD_CONTENT, RULES_CLI, RULES_MCP]) expect(text).toContain(trigger);
  });

  it("recall starts broad with search and uses grep for an exact term", () => {
    for (const text of [LCM_MD_CONTENT, RULES_MCP]) {
      expect(text.indexOf("lcm_search")).toBeLessThan(text.indexOf("lcm_grep"));
    }
  });

  it("the learning instruction can be copied verbatim into a template literal", () => {
    expect(LEARNING_INSTRUCTION).not.toContain("`");
    expect(LEARNING_INSTRUCTION).not.toContain("${");
  });
});

describe("docs/tag-schema.md", () => {
  const doc = readFileSync(join(__dirname, "..", "docs", "tag-schema.md"), "utf8");

  it("lists every type the guidance asks for", () => {
    for (const t of STORE_TYPES) expect(doc).toContain(`\`type:${t.value}\``);
  });

  it("documents every prefix and reserved tag the guidance names", () => {
    for (const p of TAG_PREFIXES) expect(doc).toContain(`\`${p}:\``);
    for (const r of ["signal:memory_used", "signal:memory_vote", "memory_id:", "vote:+1", "vote:-1"]) expect(doc).toContain(r);
  });
});
