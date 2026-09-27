#!/usr/bin/env node
// Copies .github/review-checklist.md, the one source of the repository's review
// rules, into each file a Copilot consumer reads: the code-review skill (the
// reviewer) and .github/copilot-instructions.md (the cloud agent). Each consumer
// keeps its own title and frontmatter; the rules sit between the markers below.
// test/review-checklist.test.ts fails when a consumer's copy differs.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = ".github/review-checklist.md";
export const CONSUMERS = [".agents/skills/code-review/SKILL.md", ".github/copilot-instructions.md"];
export const START = `<!-- review-checklist:start — generated from ${SOURCE} by scripts/sync-review-checklist.mjs; edit the source -->`;
export const END = "<!-- review-checklist:end -->";

/** The consumer text with the block between the markers replaced by the source. */
export function renderConsumer(consumer, source) {
  const start = consumer.indexOf(START);
  const end = consumer.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error("review-checklist markers missing or out of order");
  return `${consumer.slice(0, start)}${START}\n\n${source.trimEnd()}\n\n${consumer.slice(end)}`;
}

export function syncReviewChecklist(root) {
  const source = readFileSync(join(root, SOURCE), "utf8");
  for (const consumer of CONSUMERS) {
    const path = join(root, consumer);
    writeFileSync(path, renderConsumer(readFileSync(path, "utf8"), source));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  syncReviewChecklist(join(fileURLToPath(import.meta.url), "..", ".."));
}
