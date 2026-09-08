import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * The index and every meta.json live under a temp base dir, so these tests
 * never read or write the developer's own ~/.lossless-claude.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-group-base-")));
vi.mock("../../src/daemon/project.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/daemon/project.js")>();
  return {
    ...original,
    BASE_DIR: base,
    projectDir: (cwd: string) => join(base, "projects", original.projectId(cwd)),
    projectMetaPath: (cwd: string) => join(base, "projects", original.projectId(cwd), "meta.json"),
    ensureProjectDir: (cwd: string) => {
      const dir = join(base, "projects", original.projectId(cwd));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
});

const { backfillProjectIdentities, openProject, projectGroup, recordProjectIdentity, resolveSourceCwd, groupIndexPath } =
  await import("../../src/daemon/project-group.js");
const { projectId, projectMetaPath } = await import("../../src/daemon/project.js");

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

const readMeta = (cwd: string) => JSON.parse(readFileSync(projectMetaPath(cwd), "utf-8"));

describe("recordProjectIdentity", () => {
  it("writes the normalised remotes and relative path into meta.json", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo);
    expect(readMeta(repo).git).toMatchObject({
      remotes: ["github.com/lossless-claude/lcm"],
      relPath: "",
    });
  });

  it("keeps the project's cwd alongside the new git block", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo);
    expect(readMeta(repo).cwd).toBe(repo);
  });

  it("accumulates remotes instead of replacing them when the repository moves", () => {
    const repo = makeRepo("git@github.com:old-org/lcm.git");
    openProject(repo);
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:lossless-claude/lcm.git"],
      { cwd: repo, stdio: "ignore" });
    // Age the recorded check so the refresh actually runs.
    const meta = readMeta(repo);
    meta.git.checkedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(projectMetaPath(repo), JSON.stringify(meta, null, 2));

    expect(recordProjectIdentity(repo).remotes).toEqual([
      "github.com/lossless-claude/lcm",
      "github.com/old-org/lcm",
    ]);
  });

  it("does not re-run discovery while the recorded identity is fresh", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo);
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:other/lcm.git"],
      { cwd: repo, stdio: "ignore" });
    expect(recordProjectIdentity(repo).remotes).toEqual(["github.com/lossless-claude/lcm"]);
  });

  it("rebuilds the index from meta.json when the index is gone", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a);
    openProject(b);
    rmSync(groupIndexPath(), { force: true });
    expect(projectGroup(a).map(m => m.cwd)).toEqual([a]);

    // Both identities are still fresh, so no discovery runs — the index must
    // fill back in from what meta.json already records.
    recordProjectIdentity(a);
    recordProjectIdentity(b);
    expect(projectGroup(a).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("records an empty remote set outside any repository and stays out of the index", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "lcm-group-plain-")));
    tempDirs.push(plain);
    openProject(plain);
    expect(readMeta(plain).git.remotes).toEqual([]);
    expect(projectGroup(plain)).toEqual([{ projectId: projectId(plain), cwd: plain }]);
  });
});

describe("backfillProjectIdentities", () => {
  /** A project recorded before this feature existed: a meta.json with only a cwd. */
  function legacyProject(cwd: string): void {
    mkdirSync(join(base, "projects", projectId(cwd)), { recursive: true });
    writeFileSync(projectMetaPath(cwd), JSON.stringify({ cwd }, null, 2));
  }

  it("groups projects that were never opened again", async () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    legacyProject(a);
    legacyProject(b);

    expect(projectGroup(a).map(m => m.cwd)).toEqual([a]);
    await backfillProjectIdentities();
    expect(projectGroup(a).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("leaves a project whose folder is gone untouched", async () => {
    const gone = join(base, "no-such-checkout");
    legacyProject(gone);
    await backfillProjectIdentities();
    expect(readMeta(gone).git).toBeUndefined();
  });
});

describe("resolveSourceCwd", () => {
  it("falls back to the request's own project when no project is named", () => {
    const repo = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(repo);
    expect(resolveSourceCwd(repo, undefined)).toBe(repo);
    expect(resolveSourceCwd(repo, "")).toBe(repo);
    expect(resolveSourceCwd(repo, projectId(repo))).toBe(repo);
  });

  it("resolves a sibling in the group to that sibling's own directory", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a);
    openProject(b);
    expect(resolveSourceCwd(a, projectId(b))).toBe(b);
  });

  it("refuses a project outside the group", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const other = makeRepo("git@github.com:lossless-claude/magi.git");
    openProject(a);
    openProject(other);
    expect(resolveSourceCwd(a, projectId(other))).toBeNull();
    expect(resolveSourceCwd(a, "0".repeat(64))).toBeNull();
  });
});

describe("projectGroup", () => {
  it("groups two checkouts of the same repository", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("https://github.com/lossless-claude/lcm.git");
    openProject(a);
    openProject(b);
    expect(projectGroup(a).map(m => m.cwd).sort()).toEqual([a, b].sort());
  });

  it("keeps the queried project first", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a);
    openProject(b);
    expect(projectGroup(b)[0]).toEqual({ projectId: projectId(b), cwd: b });
  });

  it("keeps a subdirectory separate from the repository root", () => {
    const root = makeRepo("git@github.com:lossless-claude/lcm.git");
    const nested = join(root, "packages", "core");
    mkdirSync(nested, { recursive: true });
    openProject(root);
    openProject(nested);
    expect(projectGroup(root).map(m => m.cwd)).toEqual([root]);
    expect(projectGroup(nested).map(m => m.cwd)).toEqual([nested]);
  });

  it("keeps unrelated repositories apart", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const b = makeRepo("git@github.com:lossless-claude/magi.git");
    openProject(a);
    openProject(b);
    expect(projectGroup(a).map(m => m.cwd)).toEqual([a]);
  });

  it("drops a member whose directory has vanished without forgetting it", () => {
    const a = makeRepo("git@github.com:lossless-claude/lcm.git");
    const gone = makeRepo("git@github.com:lossless-claude/lcm.git");
    openProject(a);
    openProject(gone);
    rmSync(gone, { recursive: true, force: true });

    expect(projectGroup(a).map(m => m.cwd)).toEqual([a]);
    expect(existsSync(groupIndexPath())).toBe(true);
    mkdirSync(gone, { recursive: true });
    expect(projectGroup(a).map(m => m.cwd).sort()).toEqual([a, gone].sort());
  });
});
