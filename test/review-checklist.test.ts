import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSUMERS, END, SOURCE, START, renderConsumer, syncReviewChecklist } from "../scripts/sync-review-checklist.mjs";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("review checklist", () => {
  it.each(CONSUMERS)("%s carries the source verbatim (run node scripts/sync-review-checklist.mjs)", (consumer) => {
    const text = read(consumer);
    expect(renderConsumer(text, read(SOURCE))).toBe(text);
  });

  it("replaces only the block between the markers, and is idempotent", () => {
    const consumer = `# Title\n\n${START}\nold rules\n${END}\ntrailer\n`;
    const once = renderConsumer(consumer, "new rules\n");
    expect(once).toBe(`# Title\n\n${START}\n\nnew rules\n\n${END}\ntrailer\n`);
    expect(renderConsumer(once, "new rules\n")).toBe(once);
  });

  it("refuses a consumer without markers", () => {
    expect(() => renderConsumer("# Title\n", "rules")).toThrow(/markers/);
  });

  it("rewrites every consumer under the given root from its source", () => {
    const temp = mkdtempSync(join(tmpdir(), "lcm-review-checklist-"));
    try {
      for (const path of [SOURCE, ...CONSUMERS]) mkdirSync(join(temp, path, ".."), { recursive: true });
      writeFileSync(join(temp, SOURCE), "the rules\n");
      for (const consumer of CONSUMERS) writeFileSync(join(temp, consumer), `# ${consumer}\n\n${START}\nstale\n${END}\n`);

      syncReviewChecklist(temp);

      for (const consumer of CONSUMERS) {
        expect(readFileSync(join(temp, consumer), "utf8")).toBe(`# ${consumer}\n\n${START}\n\nthe rules\n\n${END}\n`);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
