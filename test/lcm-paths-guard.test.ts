// test/lcm-paths-guard.test.ts
//
// The storage root has to be resolved in one place. Four separate bugs came from it being
// read wherever it was needed: lcm could not be sandboxed, the override depended on import
// order, tests had to mock a constant, and two readers could disagree about the root.
//
// #409 threads an LcmPaths through every call site instead: defaultLcmPaths and lcmPath()
// are gone, so the type system — not convention — is what stops a path from being read out
// of the ambient environment. This test still holds the line at the literal and at the two
// remaining escape hatches (homedir(), LCM_HOME): it is a grep, not an analysis, because that
// is how every violation so far was written.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { lcmHome } from "../src/lcm-home.js";

const ROOT_LITERAL = ".lossless-claude";

/**
 * The root used to *build a path*, in either language: a quoted segment handed to `join`,
 * or the shell's own expansion. Prose that mentions `~/.lossless-claude` in an error
 * message or a comment is left alone — that is documentation, not a second resolution.
 */
const BUILDS_A_PATH = [
  /["'`]\.lossless-claude["'`]/,   // join(x, ".lossless-claude", …)
  /\$HOME\/\.lossless-claude/,     // "$HOME/.lossless-claude"
];

/** The only files allowed to name the root: the factory and the object built from it. */
const FACTORY = ["src/lcm-home.ts", "src/lcm-paths.ts"];

/**
 * The hooks module is the one exception: it runs with no imports, so it spells the
 * fallback inside the host command it sends to `sh`. The assertion below fails if that
 * stops being true, rather than leaving a dead exception behind.
 */
const HOST_COMMAND = "hooks/lcm-hooks.ts";

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src", "bin", "hooks"], { encoding: "utf-8" });
  return out.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));
}

describe("the suite never runs against the developer's own memory", () => {
  it("resolves a root of its own", () => {
    // test/setup-env.ts gives every test file its own. If that ever stops working, a test
    // that writes through lcm would reach into ~/.lossless-claude for real — and two files
    // would share one project database, which is how SQLITE_BUSY reached CI.
    expect(lcmHome()).not.toBe(join(homedir(), ".lossless-claude"));
  });
});

describe("the storage root is resolved in one place", () => {
  it("names ~/.lossless-claude only in the factory", () => {
    const offenders = sourceFiles()
      .filter((file) => !FACTORY.includes(file))
      .filter((file) => file !== HOST_COMMAND)
      .filter((file) => {
        const source = readFileSync(file, "utf-8");
        return BUILDS_A_PATH.some((pattern) => pattern.test(source));
      });
    expect(offenders, `resolve the root through createLcmPaths(lcmHome()) instead of naming ${ROOT_LITERAL}`)
      .toEqual([]);
  });

  it("still needs its one exception, so the allowance is not dead", () => {
    expect(readFileSync(HOST_COMMAND, "utf-8")).toContain(`$HOME/${ROOT_LITERAL}`);
  });

  it("reads LCM_HOME only in the factory", () => {
    const offenders = sourceFiles()
      .filter((file) => !FACTORY.includes(file))
      // The read, not the name: a doc comment may mention the variable.
      .filter((file) => /\benv\.LCM_HOME\b/.test(readFileSync(file, "utf-8")))
      // The hooks module has no imports: it reads the variable in a host command instead.
      .filter((file) => file !== "hooks/lcm-hooks.ts");
    expect(offenders, "resolve the root through lcmHome() instead of reading LCM_HOME")
      .toEqual([]);
  });
});

/**
 * `homedir()` itself is not banned: plenty of legitimate uses have nothing to do with lcm's
 * own storage. What each of these files does with it, so the allowance does not quietly grow:
 *   - expands a `~/` path the user typed themselves (a connector's own config location);
 *   - locates a host harness's own files — Claude Code's or Codex's settings, transcripts or
 *     CLAUDE.md — never lcm's.
 * A file calling `homedir()` for any other reason is exactly the bug #409 fixed: it belongs
 * in the factory, building an LcmPaths, not here.
 */
const HOMEDIR_ALLOWLIST: Record<string, string> = {
  "src/diagnose.ts": "reads Claude Code's own ~/.claude/projects transcripts",
  "src/import.ts": "reads Claude Code's own ~/.claude/projects transcripts",
  "src/codex-transcript.ts": "reads Codex's own ~/.codex transcripts",
  "src/bootstrap.ts": "locates Claude Code's own ~/.claude/settings.json",
  "src/hooks/auto-heal.ts": "locates Claude Code's own ~/.claude/settings.json",
  "src/connectors/installer.ts": "expands a `~/` path the user typed in a connector config",
  "src/doctor/doctor.ts": "reports the host home directory in a diagnostic, not an lcm path",
  "src/cli/connectors.ts": "expands --global to the user's home for a connector's own config",
  "src/daemon/project.ts": "reads Claude Code's/Codex's own transcript directories",
  "src/daemon/routes/restore.ts": "reads Claude Code's own ~/.claude/CLAUDE.md",
  "src/daemon/server.ts": "reads Claude Code's own ~/.claude/projects transcripts",
  "src/db/migration.ts": "reads Claude Code's own ~/.claude/projects transcripts",
};

describe("homedir() outside the factory never builds an lcm storage path", () => {
  it("names every remaining caller in the allowlist, with why it is not storage", () => {
    const offenders = sourceFiles()
      .filter((file) => !FACTORY.includes(file))
      .filter((file) => !(file in HOMEDIR_ALLOWLIST))
      .filter((file) => /\bhomedir\(\)/.test(readFileSync(file, "utf-8")));
    expect(offenders, "homedir() outside the factory must build a host-harness or user-typed path, not lcm's own storage root — add it to HOMEDIR_ALLOWLIST with why, or route it through createLcmPaths(lcmHome()) instead")
      .toEqual([]);
  });

  it("keeps the allowlist honest: every entry still calls homedir()", () => {
    const stale = Object.keys(HOMEDIR_ALLOWLIST)
      .filter((file) => !/\bhomedir\(\)/.test(readFileSync(file, "utf-8")));
    expect(stale, "these files no longer call homedir(); drop them from HOMEDIR_ALLOWLIST")
      .toEqual([]);
  });
});

/**
 * The call sites that still resolve a root from the ambient environment via `lcmHome()`.
 *
 * Two kinds live here, and only one of them is finished work. A **composition root** is an
 * entry point — a CLI command, a hook dispatcher, the MCP and daemon servers — and resolving
 * the root once, there, is exactly what #409 asks for. A **library fallback** is a helper
 * that resolves its own root when a caller does not hand it one; those are what #409 set out
 * to remove and has not removed yet. They are listed by name so the set cannot grow quietly,
 * and so the remaining work is visible rather than implied by the absence of a check.
 */
/** A call, not the name in a comment: the hooks module names it in prose only. */
function callsLcmHome(file: string): boolean {
  return readFileSync(file, "utf-8")
    .split("\n")
    .some((line) => !line.trimStart().startsWith("//") && /\blcmHome\(\)/.test(line));
}

const LCM_HOME_ALLOWLIST: Record<string, string> = {
  // Composition roots: one resolution, at an entry point.
  "bin/lcm.ts": "composition root: the CLI entry point",
  "src/cli/compact.ts": "composition root: the `lcm compact` command",
  "src/cli/daemon.ts": "composition root: the `lcm daemon` commands",
  "src/cli/diagnostics.ts": "composition root: the `lcm doctor`/`lcm diagnose` commands",
  "src/cli/knowledge.ts": "composition root: the import/promote/export commands",
  "src/cli/sensitive.ts": "composition root: the `lcm sensitive` commands",
  "src/daemon/server.ts": "composition root: the daemon process",
  "src/mcp/server.ts": "composition root: the MCP server process",
  "src/hooks/dispatch.ts": "composition root: the hook entry point",
  "src/hooks/codex.ts": "composition root: the Codex hook entry point",
  "src/hooks/probe-precompact.ts": "composition root: a standalone probe binary",
  "src/hooks/probe-sessionstart.ts": "composition root: a standalone probe binary",
  "src/bench.ts": "composition root: the `lcm bench` command",
  "src/doctor/doctor.ts": "composition root: the doctor run, which also reports the root",

  // Library fallbacks: #409 is not finished until each takes its paths from its caller.
  "src/batch-compact.ts": "library fallback: findProjects resolves its own projects dir",
  "src/bootstrap.ts": "library fallback: the bootstrap marker is not taken from dispatchHook's paths",
  "src/hooks/auto-heal.ts": "library fallback: defaultDeps derives auto-heal.log from the ambient root",
  "src/import.ts": "library fallback: buildProjectMap resolves its own projects dir",
  "src/memory/index.ts": "library fallback: the default client's token path is resolved at module load",
  "src/portable-knowledge.ts": "library fallback: returns the ambient root to its callers",
  "src/replay-resume.ts": "library fallback: reconstructs the project database path when lcmDir is omitted",
  "src/sensitive.ts": "library fallback: builds a config path when the caller omits one",
  "src/stats.ts": "library fallback: collectStats resolves its own root",
  "src/store/language-pack.ts": "library fallback: language packs are read and written under the ambient root",
};

describe("lcmHome() outside the factory is named, not incidental", () => {
  it("names every caller in the allowlist, composition root or remaining fallback", () => {
    const offenders = sourceFiles()
      .filter((file) => !FACTORY.includes(file))
      .filter((file) => file !== HOST_COMMAND) // spells the fallback in a shell command, not a call
      .filter((file) => !(file in LCM_HOME_ALLOWLIST))
      .filter(callsLcmHome);
    expect(offenders, "a new lcmHome() call site must be a composition root, or take its paths from its caller — add it to LCM_HOME_ALLOWLIST with which it is, or thread an LcmPaths through instead")
      .toEqual([]);
  });

  it("keeps the allowlist honest: every entry still calls lcmHome()", () => {
    const stale = Object.keys(LCM_HOME_ALLOWLIST)
      .filter((file) => !callsLcmHome(file));
    expect(stale, "these files no longer call lcmHome(); drop them from LCM_HOME_ALLOWLIST")
      .toEqual([]);
  });
});
