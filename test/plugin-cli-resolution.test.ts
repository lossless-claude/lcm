import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const commandsDir = join(__dirname, "../.claude-plugin/commands");
const commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));

describe("plugin command binary resolution (#190 #193)", () => {
  it("no command file uses the fragile 'Replace lcm with the command above' pattern", () => {
    for (const file of commandFiles) {
      const content = readFileSync(join(commandsDir, file), "utf-8");
      expect(
        content,
        `${file}: fragile binary resolution pattern found — replace with inline CLAUDE_PLUGIN_ROOT fallback`,
      ).not.toContain("Replace `lcm` with the command above in all instructions below");
    }
  });

  it("command files with executable lcm bash blocks include a CLAUDE_PLUGIN_ROOT fallback", () => {
    // Matches code blocks where the first line is a bare `lcm` invocation
    const executableLcmBlock = /```bash\nlcm /m;

    for (const file of commandFiles) {
      const content = readFileSync(join(commandsDir, file), "utf-8");
      if (executableLcmBlock.test(content)) {
        expect(
          content,
          `${file}: has executable 'lcm' bash block but no CLAUDE_PLUGIN_ROOT fallback for marketplace users`,
        ).toContain("CLAUDE_PLUGIN_ROOT");
      }
    }
  });
});
