import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverGitIdentity, normaliseRemote } from "../../src/daemon/git-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(remote?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lcm-git-identity-")));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

describe("normaliseRemote", () => {
  it("gives ssh, https and scp forms of one repository the same identity", () => {
    const expected = "github.com/lossless-claude/lcm";
    expect(normaliseRemote("git@github.com:lossless-claude/lcm.git")).toBe(expected);
    expect(normaliseRemote("https://github.com/lossless-claude/lcm.git")).toBe(expected);
    expect(normaliseRemote("https://github.com/lossless-claude/lcm")).toBe(expected);
    expect(normaliseRemote("ssh://git@github.com/lossless-claude/lcm.git")).toBe(expected);
  });

  it("lowercases the host but keeps the path's case", () => {
    expect(normaliseRemote("git@GitHub.com:Lossless-Claude/LCM.git"))
      .toBe("github.com/Lossless-Claude/LCM");
  });

  it("rejects what is not a remote", () => {
    expect(normaliseRemote("")).toBeNull();
    expect(normaliseRemote("   ")).toBeNull();
    expect(normaliseRemote("/Users/pedro/Developer/lcm")).toBeNull();
    expect(normaliseRemote("file:///Users/pedro/Developer/lcm")).toBeNull();
    expect(normaliseRemote("git@github.com:")).toBeNull();
  });
});

describe("discoverGitIdentity", () => {
  it("returns null outside a working tree", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lcm-not-a-repo-")));
    tempDirs.push(dir);
    // A temp dir can still sit inside someone's repo; only assert when it doesn't.
    const identity = discoverGitIdentity(dir);
    if (identity !== null) expect(identity.root).not.toBe(dir);
  });

  it("reports normalised remotes and an empty relative path at the root", () => {
    const dir = makeRepo("git@github.com:lossless-claude/lcm.git");
    expect(discoverGitIdentity(dir)).toEqual({
      remotes: ["github.com/lossless-claude/lcm"],
      root: dir,
      relPath: "",
    });
  });

  it("reports the path relative to the root for a subdirectory", () => {
    const dir = makeRepo("git@github.com:lossless-claude/lcm.git");
    const nested = join(dir, "packages", "core");
    mkdirSync(nested, { recursive: true });
    const identity = discoverGitIdentity(nested);
    expect(identity?.relPath).toBe("packages/core");
    expect(identity?.root).toBe(dir);
  });

  it("reports an empty remote set for a repository with no remote", () => {
    expect(discoverGitIdentity(makeRepo())?.remotes).toEqual([]);
  });
});
