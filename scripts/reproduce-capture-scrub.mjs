// Run after building: node scripts/reproduce-capture-scrub.mjs
import { DatabaseSync } from "node:sqlite";

process.env.LCM_HOME = new URL("../.scratch/capture-scrub-home", import.meta.url).pathname;
const { runLcmMigrations } = await import("../dist/src/db/migration.js");
const { SessionCapture } = await import("../dist/src/capture.js");
const { ScrubEngine } = await import("../dist/src/scrub.js");

const count = 2048;
const text = "synthetic-tool-output ".repeat(256) + " ZQX-FIXTURE-123";
let scrubCalls = 0;
let scrubbedCharacters = 0;
class CountingScrubber extends ScrubEngine {
  scrubWithCounts(text) {
    scrubCalls++;
    scrubbedCharacters += text.length;
    return super.scrubWithCounts(text);
  }
}
const db = new DatabaseSync(":memory:");
runLcmMigrations(db);
const capture = new SessionCapture(db, "fixture", new CountingScrubber(["ZQX-FIXTURE-\\d+"], []));
const messages = Array.from({ length: count }, () => ({
  role: "tool", content: text, tokenCount: 1344,
  parts: [{ type: "command", name: "/fixture", args: text }],
}));
let longestGap = 0;
let turns = 0;
let finished = false;
let previous = performance.now();
const monitor = () => {
  const now = performance.now();
  longestGap = Math.max(longestGap, now - previous);
  previous = now;
  turns++;
  if (!finished) setImmediate(monitor);
};
setImmediate(monitor);
try {
  const result = await capture.write({ sessionId: "fixture", messages });
  finished = true;
  await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({
    messages: result.records.length,
    longestEventLoopGapMs: Number(longestGap.toFixed(2)),
    eventLoopTurns: turns, scrubCalls, scrubbedCharacters,
    redactions: result.totalCounts.global,
  }));
} finally {
  finished = true;
  db.close();
}
