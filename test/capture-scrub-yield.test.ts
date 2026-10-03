import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { runLcmMigrations } from "../src/db/migration.js";
import * as queue from "../src/daemon/project-queue.js";
import { ScrubEngine } from "../src/scrub.js";
import type { ParsedMessage } from "../src/transcript.js";

const WORK_ITEMS = 12;
const SCRUB_COST_MS = 4;
const SCRUBS_PER_BUDGET = 3;
const redacted = "[REDACTED] [REDACTED] [REDACTED] [REDACTED]";
const databases = [new DatabaseSync(":memory:"), new DatabaseSync(":memory:")];
for (const db of databases) runLcmMigrations(db);
afterEach(() => vi.restoreAllMocks());
afterAll(() => { for (const db of databases) db.close(); });

function observeScrubbing(db: DatabaseSync, scrubber: ScrubEngine) {
  let elapsed = 0;
  let work = 0;
  let workAtYield = 0;
  const scrub = scrubber.scrubWithCounts.bind(scrubber);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.spyOn(scrubber, "scrubWithCounts").mockImplementation(text => {
    const result = scrub(text);
    if (text.includes("ZQX-")) {
      elapsed += SCRUB_COST_MS;
      work++;
    }
    return result;
  });
  const yields = vi.spyOn(queue, "yieldToEventLoop").mockImplementation(async () => {
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 0 });
    expect(work - workAtYield).toBeLessThanOrEqual(SCRUBS_PER_BUDGET);
    workAtYield = work;
  });
  return { yields, work: () => work };
}

it.each([
  { area: "content", db: databases[0] }, { area: "parts", db: databases[1] },
])("yields on the scrub time budget for $area before any write or transaction, preserving text and counts", async ({ area, db }) => {
  const scrubber = new ScrubEngine(["ZQX-GLOBAL-\\d+"], ["ZQX-PROJECT-\\d+"]);
  const capture = new SessionCapture(db, "fixture", scrubber);
  const observed = observeScrubbing(db, scrubber);
  const secret = "ZQX-GLOBAL-123 ZQX-PROJECT-456 ghp_" + "A".repeat(36) + " postgres://admin:fixture@db.example.invalid/demo";
  const messages: ParsedMessage[] = area === "content"
    ? Array.from({ length: WORK_ITEMS }, () => ({ role: "user", content: secret + " \0tail", tokenCount: 9 }))
    : [{
        role: "user", content: "commands", tokenCount: 2,
        parts: Array.from({ length: WORK_ITEMS }, (_, i) => ({ type: "command", name: `/command-${i}`, args: secret })),
      }];
  const original = JSON.stringify(messages);
  const result = await capture.write({ sessionId: "fixture", messages });

  expect(observed.work()).toBe(WORK_ITEMS);
  expect(result.totalCounts).toEqual({ gitleaks: WORK_ITEMS, builtIn: WORK_ITEMS, global: WORK_ITEMS, project: WORK_ITEMS });
  expect(result.records.map(record => record.content)).toEqual(area === "content"
    ? Array(WORK_ITEMS).fill(redacted + " \uFFFDtail") : ["commands"]);
  expect(result.records.map(record => record.tokenCount)).toEqual(area === "content" ? Array(WORK_ITEMS).fill(9) : [2]);
  const parts = db.prepare("SELECT tool_input FROM message_parts WHERE message_id = ? ORDER BY ordinal")
    .all(result.records[0].messageId) as Array<{ tool_input: string }>;
  expect(parts.map(part => part.tool_input)).toEqual(area === "parts" ? Array(WORK_ITEMS).fill(redacted) : []);
  expect(db.prepare("SELECT category, count FROM redaction_stats ORDER BY category").all()).toEqual([
    { category: "built_in", count: WORK_ITEMS }, { category: "gitleaks", count: WORK_ITEMS },
    { category: "global", count: WORK_ITEMS }, { category: "project", count: WORK_ITEMS },
  ]);
  expect(JSON.stringify(messages)).toBe(original);
  expect(observed.yields.mock.calls.length).toBeGreaterThan(1);
});
