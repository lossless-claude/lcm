// Run after building: node scripts/reproduce-scan-meta-cache.mjs
// The injected clock charges 2 ms per metadata read and 0.25 ms per stat.
// Gaps represent synthetic I/O pressure, independent of machine load.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = fs.mkdtempSync(join(root, ".scan-meta-repro-"));
const previousHome = process.env.LCM_HOME;
process.env.LCM_HOME = home;
const originalRead = fs.readFileSync;
const originalStat = fs.statSync;
const originalNow = performance.now;
let clock = 0, metadataReads = 0, statChecks = 0;
try {
  const { createLcmPaths } = await import("../dist/src/lcm-paths.js");
  const paths = createLcmPaths(home);
  const projects = 2000;
  for (let i = 0; i < projects; i++) {
    const dir = join(paths.projectsDir, `fixture-${String(i).padStart(4, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    if (i % 2 === 0) fs.writeFileSync(join(dir, "meta.json"), "{}");
  }
  fs.readFileSync = function (path, ...args) {
    if (String(path).endsWith("/meta.json")) { metadataReads++; clock += 2; }
    return originalRead.call(this, path, ...args);
  };
  fs.statSync = function (path, ...args) {
    statChecks++; clock += 0.25;
    return originalStat.call(this, path, ...args);
  };
  performance.now = () => clock;
  syncBuiltinESMExports();
  const { scanForTranscripts } = await import("../dist/src/daemon/server.js");
  const { loadDaemonConfig } = await import("../dist/src/daemon/config.js");
  const config = loadDaemonConfig(join(home, "config.json"), { llm: { provider: "disabled" } }, {});
  const ingest = async () => { throw new Error("Fixture has no transcripts to capture"); };
  for (const pass of ["cold", "unchanged"]) {
    metadataReads = 0; statChecks = 0;
    let longestGap = 0, previous = clock, finished = false;
    const monitor = () => {
      longestGap = Math.max(longestGap, clock - previous);
      previous = clock;
      if (!finished) setImmediate(monitor);
    };
    setImmediate(monitor);
    try {
      await scanForTranscripts(config, paths, ingest);
    } finally {
      finished = true;
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(JSON.stringify({ pass, projects, clock: "injected-work-ms", longestEventLoopGapMs: longestGap, metadataReads, statChecks }));
  }
} finally {
  fs.readFileSync = originalRead;
  fs.statSync = originalStat;
  performance.now = originalNow;
  syncBuiltinESMExports();
  if (previousHome === undefined) delete process.env.LCM_HOME;
  else process.env.LCM_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}
