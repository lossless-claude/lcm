// Build with LCM_SKIP_CACHE_SYNC=1 npm run build, then run this script with Node.
// Optional arguments: context item count, replaced item count, pass count.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SummaryStore } from "../dist/src/store/summary-store.js";

const [count, rangeSize, passes] = [100_000, 100, 10].map((fallback, i) => Number(process.argv[i + 2] ?? fallback));
if (![count, rangeSize, passes].every(value => Number.isSafeInteger(value) && value > 0)
  || count < (rangeSize - 1) * passes + 1) throw new Error("Provide positive counts with enough context items for every pass");

// Only the replacement's tables are needed; no home, daemon, migrations or model calls.
const db = new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE context_items (
    conversation_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, item_type TEXT NOT NULL,
    message_id INTEGER, summary_id TEXT, PRIMARY KEY (conversation_id, ordinal));`);
  const insert = db.prepare("INSERT INTO context_items VALUES (1, ?, 'message', ?, NULL)");
  db.exec("BEGIN");
  for (let ordinal = 0; ordinal < count; ordinal++) insert.run(ordinal, ordinal + 1);
  db.exec("COMMIT");
  const store = new SummaryStore(db, { fts5Available: false });
  const range = db.prepare("SELECT ordinal FROM context_items WHERE conversation_id = 1 ORDER BY ordinal LIMIT ?");
  const changes = () => db.prepare("SELECT total_changes() AS n").get().n;
  const before = changes();
  let lastTurn = performance.now();
  let longestGap = 0;
  const recordTurn = () => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - lastTurn);
    lastTurn = now;
  };
  await nextTurn();
  const timer = setInterval(recordTurn, 1);
  try {
    for (let pass = 0; pass < passes; pass++) {
      const ordinals = range.all(rangeSize).map(row => row.ordinal);
      lastTurn = performance.now(); // Exclude synthetic setup and range selection.
      await store.replaceContextRangeWithSummary({ conversationId: 1,
        startOrdinal: ordinals[0], endOrdinal: ordinals.at(-1), summaryId: `synthetic-${pass}` });
      await nextTurn();
      recordTurn();
    }
  } finally {
    clearInterval(timer);
  }
  console.log(JSON.stringify({ contextItems: count, rangeSize, passes,
    longestEventLoopGapMs: Number(longestGap.toFixed(3)), workCount: changes() - before,
    boundedWorkCount: passes * (rangeSize + 1) }, null, 2));
} finally {
  db.close();
}
