#!/usr/bin/env node
// PRAGMA integrity_check on every project database under the lcm home (LCM_HOME, default ~/.lossless-claude).
// Opens each database read-only, waiting up to BUSY_TIMEOUT_MS for a daemon write to finish.
// Exits 1 when any database is not "ok".
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BUSY_TIMEOUT_MS = 5000;
const home = process.env.LCM_HOME?.trim() || path.join(os.homedir(), ".lossless-claude");
const projectsDir = path.join(home, "projects");
if (!fs.existsSync(projectsDir)) {
  console.log(`No projects directory at ${projectsDir}`);
  process.exit(0);
}

const dirs = fs.readdirSync(projectsDir).filter((d) => fs.existsSync(path.join(projectsDir, d, "db.sqlite")));
if (dirs.length === 0) {
  console.log("No project databases found");
  process.exit(0);
}

let failed = 0;
for (const d of dirs) {
  const dbPath = path.join(projectsDir, d, "db.sqlite");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    const result = db.prepare("PRAGMA integrity_check").get();
    if (result.integrity_check !== "ok") {
      failed++;
      console.log(`${d.slice(0, 16)}...  FAIL: ${result.integrity_check}`);
    }
  } catch (e) {
    failed++;
    console.log(`${d.slice(0, 16)}...  ERROR: ${e.message}`);
  } finally {
    db?.close();
  }
}

console.log(`${dirs.length - failed} of ${dirs.length} project databases ok`);
process.exit(failed === 0 ? 0 : 1);
