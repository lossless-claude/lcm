import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEARNING_INSTRUCTION, LEARNING_INSTRUCTION_CLI } from "../../src/guidance.js";

// Hook modules that cannot import from src/ keep a verbatim copy of their instruction.
const copies = [
  { file: "hooks/lcm-hooks.ts", text: LEARNING_INSTRUCTION },
  { file: "hooks/omp/lcm.ts", text: LEARNING_INSTRUCTION_CLI },
];

describe("learning instruction", () => {
  for (const { file, text } of copies) {
    it(`${file} holds the same text as src/guidance.ts`, () => {
      const module = readFileSync(join(__dirname, "../..", file), "utf8");
      const match = module.match(/const LEARNING_INSTRUCTION = `([\s\S]*?)`;/);
      expect(match, `${file} must declare LEARNING_INSTRUCTION as a template literal`).not.toBeNull();
      expect(match![1]).toBe(text);
    });
  }
});
