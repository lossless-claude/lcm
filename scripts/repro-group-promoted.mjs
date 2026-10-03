// Run after LCM_SKIP_CACHE_SYNC=1 npm run build. Uses only synthetic stores.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = realpathSync(mkdtempSync(join(root, ".tmp-group-repro-")));
process.env.LCM_HOME = join(base, "memory");
process.env.LCM_LANGUAGES_DIR = join(base, "languages");
const { createLcmPaths } = await import("../dist/src/lcm-paths.js");
const { openProject } = await import("../dist/src/daemon/project-group.js");
const { projectDbPath } = await import("../dist/src/daemon/project.js");
const { runLcmMigrations } = await import("../dist/src/db/migration.js");
const { searchPromotedGroup } = await import("../dist/src/search/group-promoted.js");
const { RecallStore } = await import("../dist/src/db/recall.js");
const paths = createLcmPaths(process.env.LCM_HOME);
const work = { members: 40, feedbackReads: 0, feedbackTagReads: 0, migrationSweeps: 0, yields: 0 };
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;
const originalFeedback = RecallStore.prototype.getFeedback;
let monitoring = false;
let longestGapMs = 0;
let previousTick = 0;
let heartbeat;
try {
  const members = [];
  for (let member = 0; member < work.members; member++) {
    const cwd = join(base, `member-${String(member).padStart(2, "0")}`);
    mkdirSync(cwd);
    execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/lossless-claude/group-repro.git"], { cwd });
    openProject(cwd, paths);
    members.push(cwd);
    const dbPath = projectDbPath(cwd, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db, { claudeProjectsDir: join(base, "transcripts") });
    if (member >= 24) {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO promoted(id, content, tags, project_id) VALUES (?, ?, ?, 'synthetic')");
      for (let row = 0; row < 2000; row++) {
        insert.run(`noise-${row}`, "unrelated signal", JSON.stringify(["signal:memory_used", `memory_id:unrelated-${row}`]));
      }
      if (member >= 32) {
        for (let row = 0; row < 16; row++) {
          insert.run(`hit-${member}-${row}`, "compaction strategy", '["type:decision"]');
          insert.run(`used-${row}`, "used a strategy", JSON.stringify(["signal:memory_used", `memory_id:hit-${member}-${row}`]));
        }
      }
      db.exec("INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, content, tags FROM promoted");
      db.exec("COMMIT");
    }
    db.close();
  }

  // Count each legacy tag predicate evaluated, without changing SQLite LIKE semantics.
  DatabaseSync.prototype.prepare = function (sql) {
    if (/SELECT tags FROM promoted\s+WHERE archived_at IS NULL\s+AND tags LIKE/.test(sql)) {
      this.function("repro_feedback_tags", (tags) => { work.feedbackTagReads++; return tags; });
      sql = sql.replace(/\btags LIKE/g, "repro_feedback_tags(tags) LIKE");
    }
    return originalPrepare.call(this, sql);
  };
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS conversations")) work.migrationSweeps++;
    return originalExec.call(this, sql);
  };
  RecallStore.prototype.getFeedback = function (...args) {
    work.feedbackReads++;
    return originalFeedback.apply(this, args);
  };

  await yieldLoop();
  previousTick = performance.now();
  monitoring = true;
  const tick = () => {
    const now = performance.now();
    longestGapMs = Math.max(longestGapMs, now - previousTick);
    previousTick = now;
    if (monitoring) heartbeat = setImmediate(tick);
  };
  heartbeat = setImmediate(tick);
  const result = await searchPromotedGroup(members[0], {
    query: "compaction", limit: 16, withFeedback: true,
    yieldBetweenMembers: async () => { work.yields++; await yieldLoop(); },
  }, paths);
  await yieldLoop();
  monitoring = false;
  clearImmediate(heartbeat);
  console.log(JSON.stringify({ longestEventLoopGapMs: Number(longestGapMs.toFixed(2)), work, hits: result.hits.length, feedback: result.feedback.size }, null, 2));
} finally {
  monitoring = false;
  clearImmediate(heartbeat);
  DatabaseSync.prototype.prepare = originalPrepare;
  DatabaseSync.prototype.exec = originalExec;
  RecallStore.prototype.getFeedback = originalFeedback;
  rmSync(base, { recursive: true, force: true });
}
