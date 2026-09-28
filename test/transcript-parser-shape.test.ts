import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CLAUDE_PARSER_SHAPE, parseTranscript } from "../src/transcript.js";

it("pins every Claude tool-row shape to the current parser stamp", () => {
  const fixture = join(import.meta.dirname, "fixtures", "claude-parser-shape.jsonl");
  const snapshot = join(import.meta.dirname, "fixtures", `claude-parser-shape-${CLAUDE_PARSER_SHAPE}.json`);
  const rule = "Claude parser output changed: bump CLAUDE_PARSER_SHAPE and add its new fixture snapshot";
  expect(existsSync(snapshot), rule).toBe(true);
  expect(parseTranscript(fixture), rule).toEqual(JSON.parse(readFileSync(snapshot, "utf8")));
});
