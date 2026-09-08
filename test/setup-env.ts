import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs before every test file. The tests exercise the command hooks directly, and those
// hooks go silent when the function-hooks module owns capture (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// A developer's own Claude Code session sets that variable, and vitest inherits it, so the
// suite must not see it.
delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;

// Language packs live under ~/.lossless-claude/languages on a developer's machine. A test
// that goes through query preparation must see the same packs on every machine — none —
// unless it writes its own. The variable is inherited by the daemons the e2e tests spawn,
// and the directory is removed with the file that owns it: this runs once per test file.
const languagesDir = mkdtempSync(join(tmpdir(), "lcm-languages-"));
process.env.LCM_LANGUAGES_DIR = languagesDir;
afterAll(() => {
  rmSync(languagesDir, { recursive: true, force: true });
});
