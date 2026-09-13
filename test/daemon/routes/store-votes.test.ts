import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/** An isolated base dir, so these tests never touch the developer's own store. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-vote-base-")));
vi.mock("../../../src/daemon/project.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/daemon/project.js")>();
  const dirOf = (cwd: string) => join(base, "projects", original.projectId(cwd));
  return {
    ...original,
    BASE_DIR: base,
    projectDir: dirOf,
    projectDbPath: (cwd: string) => join(dirOf(cwd), "db.sqlite"),
    projectMetaPath: (cwd: string) => join(dirOf(cwd), "meta.json"),
    ensureProjectDir: (cwd: string) => { mkdirSync(dirOf(cwd), { recursive: true }); return dirOf(cwd); },
  };
});

const { createDaemon } = await import("../../../src/daemon/server.js");
const { loadDaemonConfig } = await import("../../../src/daemon/config.js");
const { openProject } = await import("../../../src/daemon/project-group.js");
const { projectDbPath, projectDir } = await import("../../../src/daemon/project.js");
const { runLcmMigrations } = await import("../../../src/db/migration.js");
const { PromotedStore } = await import("../../../src/db/promoted.js");

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A checkout of `remote` whose promoted memory holds `contents`. Returns the checkout's cwd and stored id(s). */
function checkout(remote: string, contents: string[]): { cwd: string; ids: string[] } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-vote-repo-")));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  openProject(cwd);

  const dbPath = projectDbPath(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const ids: string[] = [];
  try {
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    for (const content of contents) ids.push(store.insert({ content, tags: ["decision"], projectId: "p1" }));
  } finally { db.close(); }
  return { cwd, ids };
}

async function startDaemon() {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  const daemon = await createDaemon(config);
  const port = daemon.address().port;
  return { daemon, port };
}

async function postStore(port: number, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

describe("POST /store — votes", () => {
  it("stores a well-formed +1 and counts it", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-a.git", ["React is the chosen framework"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "Verified in package.json: react is still a dependency",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${ids[0]}`],
        cwd,
      });
      expect(status).toBe(200);
      expect(data.stored).toBe(true);

      const db = new DatabaseSync(projectDbPath(cwd));
      const counts = new PromotedStore(db).getVoteCounts().get(ids[0]);
      db.close();
      expect(counts?.plusOne).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it("rejects a vote with no memory_id tag", async () => {
    const { cwd } = checkout("git@github.com:lcm-vote-tests/repo-b.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "reason",
        tags: ["signal:memory_vote", "vote:+1"],
        cwd,
      });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("memory_id");
    } finally {
      await daemon.stop();
    }
  });

  it("rejects a vote with two vote: tags", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-c.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "reason",
        tags: ["signal:memory_vote", "vote:+1", "vote:-1", `memory_id:${ids[0]}`],
        cwd,
      });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("vote:");
    } finally {
      await daemon.stop();
    }
  });

  it("rejects a -1 with an empty reason", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-d.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "   ",
        tags: ["signal:memory_vote", "vote:-1", `memory_id:${ids[0]}`],
        cwd,
      });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("contradicts");
    } finally {
      await daemon.stop();
    }
  });

  it("rejects a vote whose memory_id is not found anywhere in the group", async () => {
    const { cwd } = checkout("git@github.com:lcm-vote-tests/repo-e.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "reason",
        tags: ["signal:memory_vote", "vote:+1", "memory_id:00000000-0000-0000-0000-000000000000"],
        cwd,
      });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("not found");
    } finally {
      await daemon.stop();
    }
  });

  it("counts a vote against a memory held by a sibling checkout of the same repository", async () => {
    const remote = "git@github.com:lcm-vote-tests/shared-repo.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids: siblingIds } = checkout(remote, ["compaction runs lazily"]);

    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        text: "Verified: compaction still runs lazily",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${siblingIds[0]}`],
        cwd: here,
      });
      expect(status).toBe(200);
      expect(data.stored).toBe(true);

      // The vote landed in the sibling's own database, not the voter's.
      const siblingDb = new DatabaseSync(projectDbPath(sibling));
      const counts = new PromotedStore(siblingDb).getVoteCounts().get(siblingIds[0]);
      siblingDb.close();
      expect(counts?.plusOne).toBe(1);

      const hereDb = new DatabaseSync(projectDbPath(here));
      const hereVotes = new PromotedStore(hereDb).getVoteCounts();
      hereDb.close();
      expect(hereVotes.size).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("scrubs a sibling-bound vote with the sibling's own patterns, not the voter's", async () => {
    const remote = "git@github.com:lcm-vote-tests/scrub-repo.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids: siblingIds } = checkout(remote, ["compaction runs lazily"]);
    // Only the sibling declares the pattern; the voter's own checkout knows nothing about it.
    writeFileSync(join(projectDir(sibling), "sensitive-patterns.txt"), "hunter2-vote-secret\n");

    const { daemon, port } = await startDaemon();
    try {
      const { status } = await postStore(port, {
        text: "Verified, the token hunter2-vote-secret still works",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${siblingIds[0]}`],
        cwd: here,
      });
      expect(status).toBe(200);

      const siblingDb = new DatabaseSync(projectDbPath(sibling));
      const stored = siblingDb.prepare(
        "SELECT content FROM promoted WHERE session_id IS NOT NULL AND content LIKE '%Verified%'"
      ).all() as Array<{ content: string }>;
      siblingDb.close();
      expect(stored).toHaveLength(1);
      expect(stored[0].content).not.toContain("hunter2-vote-secret");
    } finally {
      await daemon.stop();
    }
  });

  it("coalesces a repeated identical vote from the same session into one count", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-f.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const body = {
        text: "still true",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${ids[0]}`],
        cwd,
        metadata: { sessionId: "session-1" },
      };
      await postStore(port, body);
      await postStore(port, body);

      const db = new DatabaseSync(projectDbPath(cwd));
      const counts = new PromotedStore(db).getVoteCounts().get(ids[0]);
      db.close();
      expect(counts?.plusOne).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it("replaces an earlier vote with a later opposite vote from the same session", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-g.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      await postStore(port, {
        text: "still true",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${ids[0]}`],
        cwd,
        metadata: { sessionId: "session-1" },
      });
      await postStore(port, {
        text: "no longer true",
        tags: ["signal:memory_vote", "vote:-1", `memory_id:${ids[0]}`],
        cwd,
        metadata: { sessionId: "session-1" },
      });

      const db = new DatabaseSync(projectDbPath(cwd));
      const counts = new PromotedStore(db).getVoteCounts().get(ids[0]);
      db.close();
      expect(counts?.plusOne).toBe(0);
      expect(counts?.minusOne).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it("does not coalesce votes whose session fell back to 'manual'", async () => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/repo-h.git", ["some memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const body = {
        text: "still true",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${ids[0]}`],
        cwd,
      };
      await postStore(port, body);
      await postStore(port, body);

      const db = new DatabaseSync(projectDbPath(cwd));
      const counts = new PromotedStore(db).getVoteCounts().get(ids[0]);
      db.close();
      expect(counts?.plusOne).toBe(2);
    } finally {
      await daemon.stop();
    }
  });
});
