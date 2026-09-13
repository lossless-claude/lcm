import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import {
  backfillProjectIdentities, openProject, projectGroup, recordProjectIdentity, resolveSourceCwd, groupIndexPath,
} from "../../src/daemon/project-group.js";
import { projectId, projectMetaPath } from "../../src/daemon/project.js";

/**
 * The index and every meta.json live under a temp base dir, so these tests
 * never read or write the developer's own ~/.lossless-claude.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-group-base-")));
const paths: LcmPaths = createLcmPaths(base);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(remote?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lcm-group-repo-")));
  tempDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

const readMeta = (cwd: string) => JSON.parse(readFileSync(projectMetaPath(cwd, paths), "utf-8"));

describe("recordProjectIdentity", () => {
  it("writes the normalised remotes and relative path into meta.json", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo, paths);
    expect(readMeta(repo).git).toMatchObject({
      remotes: ["github.com/lossless-claude/lcm"],
      relPath: "",
    });
  });

  it("keeps the project's cwd alongside the new git block", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo, paths);
    expect(readMeta(repo).cwd).toBe(repo);
  });

  it("accumulates remotes instead of replacing them when the repository moves", () => {
    const repo = makeRepo("git@github.com:old-org/lcm.git");
    openProject(repo, paths);
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:lossless-claude/lcm.git"],
      { cwd: repo, stdio: "ignore" });
    // Age the recorded check so the refresh actually runs.
    const meta = readMeta(repo);
    meta.git.checkedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(projectMetaPath(repo, paths), JSON.stringify(meta, null, 2));

    expect(recordProjectIdentity(repo, paths).remotes).toEqual([
      "github.com/lossless-claude/lcm",
      "github.com/old-org/lcm",
    ]);
  });

  it("does not re-run discovery while the recorded identity is fresh", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo, paths);
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:other/lcm.git"],
      { cwd: repo, stdio: "ignore" });
    expect(recordProjectIdentity(repo, paths).remotes).toEqual(["github.com/lossless-claude/lcm"]);
  });

  it("rebuilds the index from meta.json when the index is gone", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a, paths);
    openProject(b, paths);
    rmSync(groupIndexPath(paths), { force: true });
    expect(projectGroup(a, paths).map(m => m.cwd)).toEqual([a]);

    // Both identities are still fresh, so no discovery runs — the index must
    // fill back in from what meta.json already records.
    recordProjectIdentity(a, paths);
    recordProjectIdentity(b, paths);
    expect(projectGroup(a, paths).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("records an empty remote set outside any repository and stays out of the index", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "lcm-group-plain-")));
    tempDirs.push(plain);
    openProject(plain, paths);
    expect(readMeta(plain).git.remotes).toEqual([]);
    expect(projectGroup(plain, paths)).toEqual([{ projectId: projectId(plain), cwd: plain }]);
  });
});

describe("backfillProjectIdentities", () => {
  /** A project recorded before this feature existed: a meta.json with only a cwd. */
  function legacyProject(cwd: string): void {
    mkdirSync(join(base, "projects", projectId(cwd)), { recursive: true });
    writeFileSync(projectMetaPath(cwd, paths), JSON.stringify({ cwd }, null, 2));
  }

  it("groups projects that were never opened again", async () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    legacyProject(a);
    legacyProject(b);

    expect(projectGroup(a, paths).map(m => m.cwd)).toEqual([a]);
    await backfillProjectIdentities(paths);
    expect(projectGroup(a, paths).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("leaves a project whose folder is gone untouched", async () => {
    const gone = join(base, "no-such-checkout");
    legacyProject(gone);
    await backfillProjectIdentities(paths);
    expect(readMeta(gone).git).toBeUndefined();
  });
});

describe("resolveSourceCwd", () => {
  it("falls back to the request's own project when no project is named", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo, paths);
    expect(resolveSourceCwd(repo, undefined, paths)).toBe(repo);
    expect(resolveSourceCwd(repo, "", paths)).toBe(repo);
    expect(resolveSourceCwd(repo, projectId(repo), paths)).toBe(repo);
  });

  it("resolves a sibling in the group to that sibling's own directory", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a, paths);
    openProject(b, paths);
    expect(resolveSourceCwd(a, projectId(b), paths)).toBe(b);
  });

  it("refuses a project outside the group", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const other = makeRepo("git@github.com:lossless-claude/magi.git");
    openProject(a, paths);
    openProject(other, paths);
    expect(resolveSourceCwd(a, projectId(other), paths)).toBeNull();
    expect(resolveSourceCwd(a, "0".repeat(64), paths)).toBeNull();
  });
});

describe("projectGroup", () => {
  it("groups two checkouts of the same repository", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("https://github.com/lossless-claude/lcm.git");
    openProject(a, paths);
    openProject(b, paths);
    expect(projectGroup(a, paths).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("keeps the queried project first", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a, paths);
    openProject(b, paths);
    expect(projectGroup(b, paths)[0]).toEqual({ projectId: projectId(b), cwd: b });
  });

  it("keeps a subdirectory separate from the repository root", () => {
    const root = makeRepo("git@github.com:lossless-claude/lcm.git");
    const nested = join(root, "packages", "core");
    mkdirSync(nested, { recursive: true });
    openProject(root, paths);
    openProject(nested, paths);
    expect(projectGroup(root, paths).map(m => m.cwd)).toEqual([root]);
    expect(projectGroup(nested, paths).map(m => m.cwd)).toEqual([nested]);
  });

  it("keeps unrelated repositories apart", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/magi.git");
    openProject(a, paths);
    openProject(b, paths);
    expect(projectGroup(a, paths).map(m => m.cwd)).toEqual([a]);
  });

  it("drops a member whose directory has vanished without forgetting it", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const gone = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a, paths);
    openProject(gone, paths);
    rmSync(gone, { recursive: true, force: true });

    expect(projectGroup(a, paths).map(m => m.cwd)).toEqual([a]);
    expect(existsSync(groupIndexPath(paths))).toBe(true);
    mkdirSync(gone, { recursive: true });
    expect(projectGroup(a, paths).map(m => m.cwd).sort()).toEqual([a, gone].sort());
  });
});
