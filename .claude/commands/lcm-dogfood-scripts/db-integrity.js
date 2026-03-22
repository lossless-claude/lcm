#!/usr/bin/env node
// Check integrity of all lcm project databases
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const os = require("os");

const projectsDir = path.join(os.homedir(), ".lossless-claude", "projects");
if (!fs.existsSync(projectsDir)) {
  console.log("No projects directory found");
  process.exit(0);
}

const dirs = fs.readdirSync(projectsDir).filter((d) => {
  const dbPath = path.join(projectsDir, d, "lcm.db");
  return fs.existsSync(dbPath);
});

if (dirs.length === 0) {
  console.log("No project databases found");
  process.exit(0);
}

let allOk = true;
for (const d of dirs) {
  const dbPath = path.join(projectsDir, d, "lcm.db");
  try {
    const db = new DatabaseSync(dbPath);
    const result = db.prepare("PRAGMA integrity_check").get();
    const status = result.integrity_check === "ok" ? "ok" : "FAIL";
    if (status !== "ok") allOk = false;
    console.log(`${d.slice(0, 16)}...  ${status}`);
    db.close();
  } catch (e) {
    console.log(`${d.slice(0, 16)}...  ERROR: ${e.message}`);
    allOk = false;
  }
}

process.exit(allOk ? 0 : 1);
