// test/lcm-paths-guard.test.ts
//
// The storage root has to be resolved in one place. Four separate bugs came from it being
// read wherever it was needed: lcm could not be sandboxed, the override depended on import
// order, tests had to mock a constant, and two readers could disagree about the root.
//
// This test holds the line while #409 threads an LcmPaths through the call sites. It is a
// grep, not an analysis: it catches the literal, which is how every one of those sites was
// written. Delete it once the default instance is gone and the types do the work.
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
    expect(offenders, `use lcmPath()/defaultLcmPaths instead of naming ${ROOT_LITERAL}`)
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
