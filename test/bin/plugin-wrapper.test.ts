import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldRunMain } from "../../bin/lcm.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("lcm.mjs plugin wrapper", () => {
  it("hands the CLI an argv[1] that satisfies its own main() guard", () => {
    // plugin.json wires every hook to `node ${CLAUDE_PLUGIN_ROOT}/lcm.mjs <cmd>`, so
    // argv[1] is the wrapper. bin/lcm.js gates main() on argv[1] resolving to itself, so
    // if the wrapper forwards argv untouched, main() never runs and the hook silently
    // no-ops. Run the real wrapper against a stub CLI and check what argv[1] it sees.
    const dir = mkdtempSync(join(tmpdir(), "lcm-wrapper-"));
    try {
      // an existing node_modules and dist keep the wrapper's bootstrap branches quiet
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      mkdirSync(join(dir, "dist", "bin"), { recursive: true });
      const stubCli = join(dir, "dist", "bin", "lcm.js");
      writeFileSync(stubCli, "console.log(process.argv[1]);\n", "utf8");
      copyFileSync(join(repoRoot, "lcm.mjs"), join(dir, "lcm.mjs"));

      const seen = execFileSync(process.execPath, [join(dir, "lcm.mjs"), "restore"], {
        encoding: "utf8",
      }).trim();

      // realpathSync because macOS resolves /var to /private/var when loading the module
      expect(seen).toBe(realpathSync(stubCli));
      expect(shouldRunMain(seen, stubCli)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
