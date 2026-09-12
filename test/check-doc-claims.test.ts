import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocClaims } from "../scripts/check-doc-claims.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A tiny fixture repo exercising the parts of bin/lcm.ts's style this script's parser
// depends on: a root `program`, a bare program-level option and a `.version()` flag (both
// meant to be global), a nested group command (`daemon`) built with `new Command` and
// reattached via `addCommand`, two of its own subcommands each with their own option, a
// top-level leaf command, and a hand-parsed one (`sensitive`) with no Commander children —
// mirroring bin/lcm.ts's real `sensitive [args...]`.
const BIN_LCM = `
import { Command } from "commander";

const program = new Command();
program.option("--quiet", "Suppress output");
program.version("1.0.0", "-r, --release-version");

const daemonCmd = new Command("daemon");
daemonCmd
  .command("start")
  .option("--detach", "Run in background");
daemonCmd
  .command("stop")
  .option("--hold", "Hold it down");
program.addCommand(daemonCmd);

program
  .command("compact")
  .option("--all", "Compact all");

program
  .command("sensitive [args...]")
  .allowUnknownOption(true);

program.parseAsync(process.argv);
`;

// `sensitive` has no Commander subcommands of its own (bin/lcm.ts hand-parses its args), so
// cli-help.ts is where its real per-word options live — this is the "sensitive purge --yes"
// case the header comment describes. `daemon` DOES have Commander children (`start`/`stop`
// above), so its bare `--`-leading entries here must be ignored rather than leaking onto
// bare `lcm daemon`, which Commander itself would reject.
const CLI_HELP = `
export const HELP = {
  sensitive: {
    summary: "Manage sensitive patterns",
    usage: "lcm sensitive <list|add|purge> [options]",
    options: [
      [\`add "<pattern>" [--global]\`, "Add a pattern"],
      ["purge [--yes]", "Purge everything"],
    ],
  },
  daemon: {
    summary: "Start, stop or restart the context daemon",
    usage: "lcm daemon <start|stop>",
    options: [
      ["--detach", "Run in the background"],
      ["--hold", "Keep it down"],
    ],
  },
};
export function printHelp() {}
`;

const MCP_TOOL = `
export const tool = { name: "lcm_test_tool" };
`;

// A command source split out of bin/lcm.ts the way a later PR will do it: the function takes
// `program` as a parameter — never a local `const program = new Command()` — so this exercises
// the root-parameter case directly. `standalone` is declared straight on that parameter (root
// path); `foo`/`bar` mirrors a group command with its own child, nested exactly one file away
// from bin/lcm.ts's own `program`.
const CLI_FOO_TS = `
import { Command } from "commander";

export function registerFooCommands(program) {
  program
    .command("standalone")
    .option("--root-flag", "Declared on the root path");

  const fooCmd = new Command("foo");
  fooCmd
    .command("bar")
    .option("--flag", "Only valid on foo bar");
  program.addCommand(fooCmd);
}
`;

function makeFixture(opts: { cliFiles?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lcm-check-doc-claims-"));
  tempDirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });

  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "mcp", "tools"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  writeFileSync(join(root, "bin", "lcm.ts"), BIN_LCM);
  writeFileSync(join(root, "src", "cli-help.ts"), CLI_HELP);
  writeFileSync(join(root, "src", "mcp", "tools", "x.ts"), MCP_TOOL);
  // Read only under test/: exercises the INTERNAL_ENV case (LCM_SKIP_CACHE_SYNC is listed
  // there as test/script/CI-only), never under a production dir.
  writeFileSync(join(root, "test", "fixture.test.ts"), `const skip = process.env.LCM_SKIP_CACHE_SYNC;\n`);

  if (opts.cliFiles) {
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    for (const [name, content] of Object.entries(opts.cliFiles)) {
      writeFileSync(join(root, "src", "cli", name), content);
    }
  }

  return root;
}

function writeDoc(root: string, relPath: string, content: string) {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  execFileSync("git", ["add", relPath], { cwd: root });
}

describe("checkDocClaims — per-path CLI options", () => {
  it("treats a flag valid on one path as an error on a different path", () => {
    const root = makeFixture();
    // --detach belongs to `daemon start`, not `daemon stop`.
    writeDoc(root, "README.md", "`lcm daemon stop --detach`\n");

    const { errors } = checkDocClaims(root);
    expect(errors.some((e) => e.includes("--detach") && e.includes("daemon stop"))).toBe(true);
  });

  it("checks two `lcm` invocations on one line independently", () => {
    const root = makeFixture();
    // First invocation misuses --hold (it belongs to `stop`, not `start`); second uses it
    // correctly. Only the first should error — proving the two are not merged into one
    // combined flag set for the line.
    writeDoc(root, "README.md", "`lcm daemon start --hold; lcm daemon stop --hold`\n");

    const { errors } = checkDocClaims(root);
    const hits = errors.filter((e) => e.includes("--hold"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("daemon start");
  });

  it("passes program.version()'s flag on every path", () => {
    const root = makeFixture();
    // --release-version is program.version()'s flag, not declared on `compact` itself.
    writeDoc(root, "README.md", "`lcm compact --release-version`\n");

    const { errors } = checkDocClaims(root);
    expect(errors).toEqual([]);
  });

  it("passes a bare program-level option on every path, not just where it was declared", () => {
    const root = makeFixture();
    // --quiet is `program.option(...)`, declared on program itself before any subcommand —
    // this is the case that only a real global-option fold (not just `.version()`) proves.
    writeDoc(root, "README.md", "`lcm daemon stop --quiet` and `lcm compact --quiet`\n");

    const { errors } = checkDocClaims(root);
    expect(errors).toEqual([]);
  });

  it("attaches cli-help.ts's hand-parsed subcommand flags to their own path, not the bare section", () => {
    const root = makeFixture();
    // `sensitive` has no Commander children, so cli-help.ts is the only source of its real
    // per-word flags: `add --global` and `purge --yes` are valid, but --yes is only valid
    // after `purge`, not on bare `lcm sensitive`.
    writeDoc(root, "README.md", '`lcm sensitive add --global "x"` and `lcm sensitive purge --yes`\n');

    const { errors } = checkDocClaims(root);
    expect(errors).toEqual([]);
  });

  it("does not let cli-help.ts's flattened option list leak onto a group command that has real Commander children", () => {
    const root = makeFixture();
    // `daemon` DOES have Commander subcommands (start/stop, declared in bin/lcm.ts above),
    // so cli-help.ts's bare `--hold` entry under `daemon:` must not validate bare
    // `lcm daemon --hold` — Commander itself would reject it.
    writeDoc(root, "README.md", "`lcm daemon --hold`\n");

    const { errors } = checkDocClaims(root);
    expect(errors.some((e) => e.includes("--hold"))).toBe(true);
  });

  it("warns per path when a declared option is never mentioned", () => {
    const root = makeFixture();
    // Mention daemon start/stop and compact by name, but never compact's --all.
    writeDoc(root, "README.md", "`lcm daemon start --detach` and `lcm daemon stop --hold` and `lcm compact`\n");

    const { warnings } = checkDocClaims(root);
    expect(warnings.some((w) => w === "lcm compact --all is not mentioned by any tracked document")).toBe(true);
    // The ones actually mentioned must not also warn.
    expect(warnings.some((w) => w.includes("daemon start --detach"))).toBe(false);
    expect(warnings.some((w) => w.includes("daemon stop --hold"))).toBe(false);
  });

  it("produces no warning for an INTERNAL_ENV variable", () => {
    const root = makeFixture();
    writeDoc(root, "README.md", "`lcm compact`\n");

    const { warnings } = checkDocClaims(root);
    expect(warnings.some((w) => w.includes("LCM_SKIP_CACHE_SYNC"))).toBe(false);
  });
});

describe("checkDocClaims — command sources under src/cli/", () => {
  it("accepts a flag declared in src/cli/foo.ts on the command path it was declared on", () => {
    const root = makeFixture({ cliFiles: { "foo.ts": CLI_FOO_TS } });
    writeDoc(root, "README.md", "`lcm foo bar --flag`\n");

    const { errors } = checkDocClaims(root);
    expect(errors).toEqual([]);
  });

  it("rejects that same flag claimed on a different command path", () => {
    const root = makeFixture({ cliFiles: { "foo.ts": CLI_FOO_TS } });
    // `compact` is a real path (declared in bin/lcm.ts) that does not declare --flag.
    writeDoc(root, "README.md", "`lcm compact --flag`\n");

    const { errors } = checkDocClaims(root);
    expect(errors.some((e) => e.includes("--flag") && e.includes("lcm compact"))).toBe(true);
  });

  it("attributes a src/cli file's root-parameter command to the root path", () => {
    const root = makeFixture({ cliFiles: { "foo.ts": CLI_FOO_TS } });
    // `standalone` is declared directly on the `program` parameter passed into
    // registerFooCommands — never a local `new Command()` in that file — so it must resolve
    // to the root path (`lcm standalone`), not go unrecognised.
    writeDoc(root, "README.md", "`lcm standalone --root-flag`\n");

    const { errors } = checkDocClaims(root);
    expect(errors).toEqual([]);
  });
});
