import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasCommandHelp, printHelp } from "../src/cli-help.js";
import {
  LCM_MD_CONTENT, LEARNING_INSTRUCTION, RULES_CLI, RULES_MCP, SKILL,
  STORE_TOOL_DESCRIPTION, STORE_TOOL_TAGS_DESCRIPTION, STORE_TYPES, TAG_PREFIXES,
} from "../src/guidance.js";

const RESERVED = ["signal:memory_used", "signal:memory_vote", "memory_id:<id>", "vote:+1", "vote:-1"];

const surfaces = [
  { name: "lcm.md", text: LCM_MD_CONTENT, noun: "lcm_store", reserved: false },
  { name: "learning instruction", text: LEARNING_INSTRUCTION, noun: "lcm_store", reserved: true },
  { name: "CLI rules", text: RULES_CLI, noun: "lcm store", reserved: true },
  { name: "skill", text: SKILL, noun: "lcm store", reserved: true },
  { name: "MCP rules", text: RULES_MCP, noun: "lcm_store", reserved: true },
  { name: "lcm_store definition", text: `${STORE_TOOL_DESCRIPTION}\n${STORE_TOOL_TAGS_DESCRIPTION}`, noun: "lcm_search", reserved: true },
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
      expect(s.text).toContain(s.noun);
    });

    it(`${s.name} ${s.reserved ? "carries" : "leaves out"} the reserved tags`, () => {
      for (const r of RESERVED) {
        if (s.reserved) expect(s.text).toContain(r);
        else expect(s.text).not.toContain(r);
      }
    });
  }

  it("the CLI rules never name an MCP tool, and the MCP surfaces never name a CLI command", () => {
    for (const text of [RULES_CLI, SKILL]) expect(text).not.toMatch(/lcm_\w+/);
    for (const text of [RULES_MCP, LCM_MD_CONTENT, LEARNING_INSTRUCTION]) expect(text).not.toMatch(/`lcm [a-z]/);
  });

  it("the surfaces that say when to search say it the same way", () => {
    const trigger = "Search memory before a code task in this project";
    for (const text of [LCM_MD_CONTENT, RULES_CLI, RULES_MCP, SKILL]) expect(text).toContain(trigger);
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

describe("the CLI rules name only commands and flags the CLI documents", () => {
  const commands = [...`${RULES_CLI}\n${SKILL}`.matchAll(/`lcm ([a-z][a-z-]*)([^`]*)`/g)];

  it("names at least the recall and store commands", () => {
    expect(commands.map((m) => m[1])).toEqual(expect.arrayContaining(["search", "grep", "describe", "expand", "store"]));
  });

  for (const [, command, rest] of commands) {
    it(`lcm ${command}${rest}`, () => {
      expect(hasCommandHelp(command)).toBe(true);
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        printHelp(command);
        const help = write.mock.calls.map((c) => String(c[0])).join("");
        for (const flag of rest.match(/--[a-z-]+/g) ?? []) expect(help).toContain(flag);
      } finally {
        write.mockRestore();
      }
    });
  }
});

describe("docs/tag-schema.md", () => {
  const doc = readFileSync(join(__dirname, "..", "docs", "tag-schema.md"), "utf8");

  it("defines every type the guidance asks for the way the guidance does", () => {
    for (const t of STORE_TYPES) {
      const when = t.when.charAt(0).toUpperCase() + t.when.slice(1);
      expect(doc).toContain(`| \`type:${t.value}\` | ${when} |`);
    }
  });

  it("documents every prefix and reserved tag the guidance names", () => {
    for (const p of TAG_PREFIXES) expect(doc).toContain(`\`${p}:\``);
    for (const r of ["signal:memory_used", "signal:memory_vote", "memory_id:", "vote:+1", "vote:-1"]) expect(doc).toContain(r);
  });
});

describe("the lcm-memory skill", () => {
  it("is model-invoked, so its description says when to use it", () => {
    const description = SKILL.match(/^description: (.*)$/m)?.[1] ?? "";
    expect(SKILL).not.toContain("disable-model-invocation");
    expect(description).toMatch(/Use before a code task/);
    expect(description).toMatch(/when a durable insight/);
  });

  it("states the search-then-store flow once", () => {
    expect(SKILL.split("Search memory before a code task").length - 1).toBe(1);
    expect(SKILL.split("Store durable insights").length - 1).toBe(1);
  });

  it("is what this repository's development copy holds", () => {
    const copy = readFileSync(join(__dirname, "..", ".agents", "skills", "lcm-memory", "SKILL.md"), "utf8");
    expect(copy).toBe(SKILL);
  });
});
