import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSUMERS, END, SOURCE, START, renderConsumer } from "../scripts/sync-review-checklist.mjs";

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
});
