import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEARNING_INSTRUCTION } from "../../src/hooks/learning-instruction.js";

describe("learning instruction", () => {
  it("is the same text in the command hook and in the function-hooks module", () => {
    const module = readFileSync(join(__dirname, "../../hooks/lcm-hooks.ts"), "utf8");
    const match = module.match(/const LEARNING_INSTRUCTION = `([\s\S]*?)`;/);
    expect(match, "hooks/lcm-hooks.ts must declare LEARNING_INSTRUCTION as a template literal").not.toBeNull();
    expect(match![1]).toBe(LEARNING_INSTRUCTION);
  });
});
