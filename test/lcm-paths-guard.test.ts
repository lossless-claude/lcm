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

const ROOT_LITERAL = ".lossless-claude";

/** The only files allowed to name the root: the factory and the object built from it. */
const FACTORY = ["src/lcm-home.ts", "src/lcm-paths.ts"];

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src", "bin", "hooks"], { encoding: "utf-8" });
  return out.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));
}

describe("the storage root is resolved in one place", () => {
  it("names ~/.lossless-claude only in the factory", () => {
    const offenders = sourceFiles()
      .filter((file) => !FACTORY.includes(file))
      .filter((file) => readFileSync(file, "utf-8").includes(`"${ROOT_LITERAL}`));
    expect(offenders, `use lcmPath()/defaultLcmPaths instead of naming ${ROOT_LITERAL}`)
      .toEqual([]);
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
