import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll } from "vitest";
import { assertIsolatedTestHome, lcmHome } from "../src/lcm-home.js";
import { createLcmPaths } from "../src/lcm-paths.js";

// OS identity is independent of HOME and LCM_HOME inherited from the runner.
// Retain it in children so their later environment changes cannot select real stores.
process.env.LCM_TEST_REAL_HOME = join(userInfo().homedir, ".lossless-claude");
assertIsolatedTestHome(tmpdir()); // Reject a protected temporary base before allocating any directory.

// Everything lcm stores goes to a directory this file owns, so no test can reach the
// developer's real memory — and, because each test file gets its own, two files cannot
// contend for one project database. That contention is not hypothetical: it answered
// SQLITE_BUSY on the CI runner, where the suite runs in parallel, and never here.
// Set before the test file's imports, since the root is resolved when a module loads.
const lcmHomeDir = mkdtempSync(join(tmpdir(), "lcm-home-"));
process.env.LCM_HOME = lcmHomeDir;
createLcmPaths(lcmHome()); // Refuse an unsafe resolved root before the first write.
afterAll(() => {
  rmSync(lcmHomeDir, { recursive: true, force: true });
});

// HOME moves too: lcm writes outside its own home (`~/.claude/settings.json` from ensureCore
// and hook auto-heal), and a child whose LCM_HOME is unset falls back to
// `$HOME/.lossless-claude`. A directory of its own, not LCM_HOME, so the two stay distinct.
const homeDir = mkdtempSync(join(tmpdir(), "lcm-user-home-"));
process.env.HOME = homeDir;
afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

// The lcm home names a daemon port nobody listens on. Without it every caller resolves the
// compiled-in default, which is where the developer's own daemon (and the CI runner's, same
// user) listens — and `ensureDaemon` SIGTERMs a daemon there whose version differs from the
// caller's. Reserved and released rather than held: a held port whose owner is blocked in
// spawnSync would leave the CLI children that probe it hanging instead of refused.
const unusedPort = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});
writeFileSync(join(lcmHomeDir, "config.json"), JSON.stringify({ daemon: { port: unusedPort } }));

// The catch-all for a test that points LCM_HOME or HOME at a directory of its own and writes
// no port there: the default port is refused in this worker and, through NODE_OPTIONS, in
// every child it spawns (see setup-port-guard.mjs). A refusal fails this test file.
const DEFAULT_DAEMON_PORT = 3737; // DEFAULTS.daemon.port in src/daemon/config.ts; test/port-guard.test.ts pins it
const guardDir = mkdtempSync(join(tmpdir(), "lcm-port-guard-"));
process.env.LCM_TEST_GUARDED_PORTS = String(DEFAULT_DAEMON_PORT);
process.env.LCM_TEST_GUARD_DIR = guardDir;
const guardModule = pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "setup-port-guard.mjs")).href;
const preload = `--import=${JSON.stringify(guardModule)}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(guardModule)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
}
await import(guardModule);
afterAll(() => {
  const violations = readdirSync(guardDir).map((name) => readFileSync(join(guardDir, name), "utf8").trim());
  rmSync(guardDir, { recursive: true, force: true });
  if (violations.length > 0) throw new Error(violations.join("\n"));
});

// Language packs live under ~/.lossless-claude/languages on a developer's machine. A test
// that goes through query preparation must see the same packs on every machine — none —
// unless it writes its own. The variable is inherited by the daemons the e2e tests spawn,
// and the directory is removed with the file that owns it: this runs once per test file.
const languagesDir = mkdtempSync(join(tmpdir(), "lcm-languages-"));
process.env.LCM_LANGUAGES_DIR = languagesDir;
afterAll(() => {
  rmSync(languagesDir, { recursive: true, force: true });
});
