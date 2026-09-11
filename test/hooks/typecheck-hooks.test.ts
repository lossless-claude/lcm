import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const SCRIPT = resolve(__dirname, "../../scripts/typecheck-hooks.sh");

/**
 * The script's job is to refuse rather than reassure, so the cases worth pinning are
 * the ones where it must not reach the compiler. `npx` is stubbed too: a run that gets
 * that far has already passed the guard, and the real compiler would only make the
 * test slow and dependent on the module compiling.
 */
async function run(options: { header?: string; claudeVersion?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "lcm-typecheck-"));
  const bin = join(dir, "bin");
  await execute("mkdir", ["-p", bin]);
  const types = join(dir, "claude-code.d.ts");
  if (options.header !== undefined) {
    writeFileSync(types, `${options.header}\ndeclare module "claude-code" {}\n`);
  }
  // A stub compiler: reaching it means the guard let the run through.
  const npx = join(bin, "npx");
  writeFileSync(npx, "#!/bin/sh\necho stub-tsc\n");
  chmodSync(npx, 0o755);
  if (options.claudeVersion !== undefined) {
    const claude = join(bin, "claude");
    writeFileSync(claude, `#!/bin/sh\necho "${options.claudeVersion} (Claude Code)"\n`);
    chmodSync(claude, 0o755);
  }
  try {
    const { stdout } = await execute("bash", [SCRIPT], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOOKS_TYPES: types },
    });
    return { exitCode: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("typecheck-hooks staleness guard", () => {
  it("refuses when the declarations are older than the installed build", async () => {
    const result = await run({ header: "// Written by Claude Code 2.1.263.", claudeVersion: "2.1.267" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Declarations are from Claude Code 2.1.263, but 2.1.267 is installed");
    expect(result.output).toContain("/plugin-types");
    expect(result.output).not.toContain("stub-tsc");
  });

  // /plugin-types writes what the session it runs in knows. After an update the running
  // session is still the old build, so regenerating there returns the old version and a
  // message naming only that command sends the reader round in a circle.
  it("says to restart before regenerating, since a running session writes its own build", async () => {
    const result = await run({ header: "// Written by Claude Code 2.1.267.", claudeVersion: "2.1.268" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Restart Claude Code so a session runs 2.1.268");
  });

  it("compiles when the declarations match the installed build", async () => {
    const result = await run({ header: "// Written by Claude Code 2.1.267.", claudeVersion: "2.1.267" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stub-tsc");
  });

  // CI has no Claude Code, so the guard cannot confirm freshness there. It says so
  // rather than failing: the type-check still holds the module to the declarations
  // it has, it just cannot claim they are current.
  it("says it cannot confirm freshness when no Claude Code is installed", async () => {
    const result = await run({ header: "// Written by Claude Code 2.1.263." });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("cannot confirm the declarations match a running build");
    expect(result.output).toContain("stub-tsc");
  });

  it("does not claim a match when the header carries no version", async () => {
    const result = await run({ header: "// Written by some other tool.", claudeVersion: "2.1.267" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("no version in its header");
  });

  it("names /plugin-types when the declarations are missing entirely", async () => {
    const result = await run({ claudeVersion: "2.1.267" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("/plugin-types");
    expect(result.output).not.toContain("stub-tsc");
  });
});
