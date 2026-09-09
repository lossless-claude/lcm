import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs before every test file. The tests exercise the command hooks directly, and those
// hooks go silent when the function-hooks module owns capture (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// A developer's own Claude Code session sets that variable, and vitest inherits it, so the
// suite must not see it.
delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;

// Everything lcm stores goes to a directory this file owns, so no test can reach the
// developer's real memory — and, because each test file gets its own, two files cannot
// contend for one project database. That contention is not hypothetical: it answered
// SQLITE_BUSY on the CI runner, where the suite runs in parallel, and never here.
// Set before the test file's imports, since the root is resolved when a module loads.
const lcmHomeDir = mkdtempSync(join(tmpdir(), "lcm-home-"));
process.env.LCM_HOME = lcmHomeDir;
afterAll(() => {
  rmSync(lcmHomeDir, { recursive: true, force: true });
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
