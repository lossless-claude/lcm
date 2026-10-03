// Run after building: node scripts/reproduce-lesson-refresh.mjs
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../dist/src/db/migration.js";
import { ToolLessonStore } from "../dist/src/promotion/tool-lessons.js";
import { ToolLessonProjection } from "../dist/src/promotion/tool-lesson-projection.js";

const db = new DatabaseSync(":memory:");
runLcmMigrations(db);
const message = db.prepare("INSERT INTO messages (conversation_id, seq, role, content, token_count, event_at) VALUES (?, ?, 'tool', 'fixture', 1, '2026-01-01T00:00:00Z')");
const call = db.prepare("INSERT INTO transcript_tool_calls (session_id, call_id, message_id, name, input, outcome) VALUES (?, ?, ?, 'Bash', ?, ?)");
db.exec("BEGIN");
for (let session = 0; session < 4; session++) {
  const sessionId = `fixture-${session}`;
  const conversation = db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run(sessionId).lastInsertRowid;
  for (let index = 0; index < 1024; index++) {
    const id = message.run(conversation, index).lastInsertRowid;
    call.run(sessionId, String(index), id, `npm install package-${index}`, index % 8 === 7 ? "succeeded" : "failed");
  }
}
db.exec("COMMIT");

let pairEvaluations = 0, longestGap = 0, finished = false;
const replace = ToolLessonProjection.prototype.replaceContribution;
ToolLessonProjection.prototype.replaceContribution = function (...args) {
  if (args[1] === "error-fix") pairEvaluations++;
  return replace.apply(this, args);
};
let previous = performance.now();
const monitor = () => {
  const now = performance.now();
  longestGap = Math.max(longestGap, now - previous);
  previous = now;
  if (!finished) setImmediate(monitor);
};
setImmediate(monitor);
try {
  await new ToolLessonStore(db).refresh("fixture");
  finished = true;
  await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ calls: 4096, longestEventLoopGapMs: Number(longestGap.toFixed(2)), pairEvaluations }));
} finally {
  finished = true;
  ToolLessonProjection.prototype.replaceContribution = replace;
  db.close();
}
