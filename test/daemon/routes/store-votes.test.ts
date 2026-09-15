import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** An isolated base dir, so these tests never touch the developer's own store. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "lcm-vote-base-")));
const scrubGate = vi.hoisted(() => ({ wait: null as null | (() => Promise<unknown>) }));
vi.mock("../../../src/scrub.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/scrub.js")>();
  return {
    ...original,
    ScrubEngine: {
      ...original.ScrubEngine,
      forProject: (...args: Parameters<typeof original.ScrubEngine.forProject>) => scrubGate.wait ? scrubGate.wait() : original.ScrubEngine.forProject(...args),
    },
  };
});
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
const { createLcmPaths } = await import("../../../src/lcm-paths.js");

const paths = createLcmPaths(base);
const { projectDbPath, projectDir } = await import("../../../src/daemon/project.js");
const { projectId } = await import("../../../src/daemon/project.js");
const { runLcmMigrations } = await import("../../../src/db/migration.js");
const { PromotedStore } = await import("../../../src/db/promoted.js");
const { collectStats } = await import("../../../src/stats.js");
const { getPoolStats } = await import("../../../src/db/connection.js");
const { ConversationStore } = await import("../../../src/store/conversation-store.js");

const tempDirs: string[] = [];
// Per test, not once at load: the group index and the daemon's own LcmPaths come from the
// storage root rather than from the project mock, and another suite file points the same
// variable at its own base — whichever loaded last would otherwise win for both.
beforeEach(() => { process.env.LCM_HOME = base; });
afterEach(() => { scrubGate.wait = null; for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A checkout of `remote` whose promoted memory holds `contents`. Returns the checkout's cwd and stored id(s). */
function checkout(remote: string, contents: string[]): { cwd: string; ids: string[] } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-vote-repo-")));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  openProject(cwd, paths);

  const dbPath = projectDbPath(cwd, paths);
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

function unregisteredCheckout(remote: string): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-vote-repo-")));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd, stdio: "ignore" });
  return cwd;
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

async function postReviewStale(port: number, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/review-stale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

describe("POST /store — votes", () => {
  it.each([
    ["missing target", ["signal:memory_used"]],
    ["empty target", ["signal:memory_used", "memory_id:"]],
    ["duplicate targets", ["signal:memory_used", "memory_id:first", "memory_id:second"]],
  ])("rejects a use signal with %s without storing it", async (_label, tags) => {
    const { cwd } = checkout("git@github.com:lcm-vote-tests/invalid-use.git", []);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, { cwd, text: "used a memory", tags });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("exactly one non-empty memory_id");
      const db = new DatabaseSync(projectDbPath(cwd, paths));
      const signals = db.prepare("SELECT COUNT(*) AS count FROM promoted WHERE tags LIKE '%memory_used%'").get() as { count: number };
      db.close();
      expect(signals.count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it.each([null, 42, ""])("rejects an invalid owner_project_id without treating it as local", async (owner_project_id) => {
    const { cwd, ids } = checkout("git@github.com:lcm-vote-tests/invalid-owner.git", ["local memory"]);
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postReviewStale(port, {
        cwd, action: "archive", target_id: ids[0], owner_project_id,
      });
      expect(status).toBe(400);
      expect(String(data.error)).toContain("owner_project_id");

      const db = new DatabaseSync(projectDbPath(cwd, paths));
      const row = db.prepare("SELECT archived_at FROM promoted WHERE id = ?").get(ids[0]) as { archived_at: string | null };
      db.close();
      expect(row.archived_at).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

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

      const db = new DatabaseSync(projectDbPath(cwd, paths));
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
      const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
      const counts = new PromotedStore(siblingDb).getVoteCounts().get(siblingIds[0]);
      siblingDb.close();
      expect(counts?.plusOne).toBe(1);

      const hereDb = new DatabaseSync(projectDbPath(here, paths));
      const hereVotes = new PromotedStore(hereDb).getVoteCounts();
      hereDb.close();
      expect(hereVotes.size).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("stores uses with their sibling-owned memory so promotion feedback has one owner", async () => {
    const remote = "git@github.com:lcm-vote-tests/uses-repo.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids } = checkout(remote, ["compaction runs lazily"]);
    const { daemon, port } = await startDaemon();
    try {
      for (let i = 0; i < 3; i++) {
        const { status } = await postStore(port, {
          text: `Used sibling memory ${i}`,
          tags: ["signal:memory_used", `memory_id:${ids[0]}`],
          cwd: here,
        });
        expect(status).toBe(200);
      }

      const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
      const siblingUses = siblingDb.prepare("SELECT COUNT(*) AS count FROM promoted WHERE tags LIKE '%memory_used%'").get() as { count: number };
      siblingDb.close();
      expect(siblingUses.count).toBe(3);

      const hereDb = new DatabaseSync(projectDbPath(here, paths));
      const hereUses = hereDb.prepare("SELECT COUNT(*) AS count FROM promoted WHERE tags LIKE '%memory_used%'").get() as { count: number };
      hereDb.close();
      expect(hereUses.count).toBe(0);

      const candidate = collectStats(paths).promotionCandidates.find((entry) => entry.id === ids[0]);
      expect(candidate).toMatchObject({ useCount: 3, ownerProjectId: projectId(sibling) });
    } finally {
      await daemon.stop();
    }
  });

  it("rejects a use when its target is archived while scrubber initialization is paused", async () => {
    const remote = "git@github.com:lcm-vote-tests/use-race.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids } = checkout(remote, ["target"]);
    let resume!: () => void;
    let paused!: () => void;
    const pause = new Promise<void>((resolve) => { paused = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    scrubGate.wait = async () => { paused(); await release; return { scrub: (text: string) => text }; };
    const { daemon, port } = await startDaemon();
    try {
      const pending = postStore(port, { cwd: here, text: "used target", tags: ["signal:memory_used", `memory_id:${ids[0]}`] });
      await pause;
      const db = new DatabaseSync(projectDbPath(sibling, paths));
      new PromotedStore(db).archive(ids[0]);
      db.close();
      resume();
      const { status } = await pending;
      expect(status).toBe(400);
      const after = new DatabaseSync(projectDbPath(sibling, paths));
      const signals = after.prepare("SELECT COUNT(*) AS count FROM promoted WHERE tags LIKE '%memory_used%'").get() as { count: number };
      after.close();
      expect(signals.count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("discovers a sibling memory created by an ordinary store request", async () => {
    const remote = "git@github.com:lcm-vote-tests/ordinary-store-registration.git";
    const here = unregisteredCheckout(remote);
    const sibling = unregisteredCheckout(remote);
    const { daemon, port } = await startDaemon();
    try {
      const stored = await postStore(port, { cwd: sibling, text: "stored in a sibling", tags: ["decision"] });
      expect(stored.status).toBe(200);
      const used = await postStore(port, {
        cwd: here,
        text: "used the sibling memory",
        tags: ["signal:memory_used", `memory_id:${String(stored.data.id)}`],
      });
      expect(used.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it("counts a legacy requester-side use once with later owner-side uses", async () => {
    const remote = "git@github.com:lcm-vote-tests/legacy-use-upgrade.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids } = checkout(remote, ["sibling memory"]);
    const hereDb = new DatabaseSync(projectDbPath(here, paths));
    new PromotedStore(hereDb).insert({
      content: "legacy use", tags: ["signal:memory_used", `memory_id:${ids[0]}`], projectId: "p1",
    });
    hereDb.close();

    const { daemon, port } = await startDaemon();
    try {
      for (let i = 0; i < 2; i++) {
        expect((await postStore(port, {
          cwd: here, text: `new use ${i}`, tags: ["signal:memory_used", `memory_id:${ids[0]}`],
        })).status).toBe(200);
      }
      const candidates = collectStats(paths).promotionCandidates.filter((candidate) => candidate.id === ids[0]);
      expect(candidates).toEqual([expect.objectContaining({ ownerProjectId: projectId(sibling), useCount: 3 })]);
    } finally {
      await daemon.stop();
    }
  });

  it("does not list a sibling-owned memory as stale when a legacy use exists in this checkout", async () => {
    const remote = "git@github.com:lcm-vote-tests/legacy-stale.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids } = checkout(remote, ["old sibling memory"]);
    const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
    siblingDb.prepare("UPDATE promoted SET created_at = datetime('now', '-120 days') WHERE id = ?").run(ids[0]);
    siblingDb.close();
    const hereDb = new DatabaseSync(projectDbPath(here, paths));
    new PromotedStore(hereDb).insert({ content: "legacy use", tags: ["signal:memory_used", `memory_id:${ids[0]}`], projectId: "p1" });
    hereDb.close();
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postReviewStale(port, { cwd: here });
      expect(status).toBe(200);
      expect((data.stale as Array<{ id: string }>).some((entry) => entry.id === ids[0])).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it("excludes a legacy-used sibling memory from collectStats staleCount", async () => {
    const remote = "git@github.com:lcm-vote-tests/legacy-stats-stale.git";
    const { cwd: requester } = checkout(remote, []);
    const { cwd: owner, ids } = checkout(remote, ["old owner memory"]);
    const ownerDb = new DatabaseSync(projectDbPath(owner, paths));
    ownerDb.prepare("UPDATE promoted SET created_at = datetime('now', '-120 days') WHERE id = ?").run(ids[0]);
    const conversations = new ConversationStore(ownerDb);
    const conversation = await conversations.getOrCreateConversation("stale-owner-session");
    await conversations.createMessagesBulk([{ conversationId: conversation.conversationId, seq: 0, role: "user", content: "owner activity", tokenCount: 1 }]);
    ownerDb.close();
    const requesterDb = new DatabaseSync(projectDbPath(requester, paths));
    new PromotedStore(requesterDb).insert({ content: "legacy use", tags: ["signal:memory_used", `memory_id:${ids[0]}`], projectId: "p1" });
    requesterDb.close();

    expect(collectStats(paths).staleCount).toBe(0);
  });

  it("lists valid stale memories when a sibling database is partial and closes group handles", async () => {
    const remote = "git@github.com:lcm-vote-tests/partial-stale-group.git";
    const partial = unregisteredCheckout(remote);
    openProject(partial, paths);
    const partialPath = projectDbPath(partial, paths);
    mkdirSync(dirname(partialPath), { recursive: true });
    const partialDb = new DatabaseSync(partialPath);
    partialDb.exec("CREATE TABLE partial (value TEXT)");
    partialDb.close();
    const { cwd: valid, ids } = checkout(remote, ["valid stale memory"]);
    const validDb = new DatabaseSync(projectDbPath(valid, paths));
    validDb.prepare("UPDATE promoted SET created_at = datetime('now', '-120 days') WHERE id = ?").run(ids[0]);
    validDb.close();
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postReviewStale(port, { cwd: valid });
      expect(status).toBe(200);
      expect((data.stale as Array<{ id: string }>).map((entry) => entry.id)).toContain(ids[0]);
      expect(getPoolStats().connections.filter((entry) => [partialPath, projectDbPath(valid, paths)].includes(entry.path))).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("archives and revives a valid memory despite a sibling whose database path is unreadable", async () => {
    const remote = "git@github.com:lcm-vote-tests/unreadable-action-group.git";
    const unreadable = unregisteredCheckout(remote);
    openProject(unreadable, paths);
    const unreadablePath = projectDbPath(unreadable, paths);
    mkdirSync(unreadablePath, { recursive: true });
    const { cwd: valid, ids } = checkout(remote, ["valid target"]);
    const { daemon, port } = await startDaemon();
    try {
      for (const [action, expected] of [["archive", "archived"], ["revive", "revived"]] as const) {
        const { status, data } = await postReviewStale(port, { cwd: valid, action, target_id: ids[0] });
        expect(status).toBe(200);
        expect(data.action).toBe(expected);
      }
      expect(getPoolStats().connections.filter((entry) => [unreadablePath, projectDbPath(valid, paths)].includes(entry.path))).toEqual([]);
    } finally { await daemon.stop(); }
  });

  it("lists valid stale memory despite a sibling whose database path is unreadable", async () => {
    const remote = "git@github.com:lcm-vote-tests/unreadable-list-group.git";
    const unreadable = unregisteredCheckout(remote);
    openProject(unreadable, paths);
    const unreadablePath = projectDbPath(unreadable, paths);
    mkdirSync(unreadablePath, { recursive: true });
    const { cwd: valid, ids } = checkout(remote, ["valid stale"]);
    const db = new DatabaseSync(projectDbPath(valid, paths));
    db.prepare("UPDATE promoted SET created_at = datetime('now', '-120 days') WHERE id = ?").run(ids[0]);
    db.close();
    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postReviewStale(port, { cwd: valid });
      expect(status).toBe(200);
      expect((data.stale as Array<{ id: string }>).map((entry) => entry.id)).toContain(ids[0]);
      expect(getPoolStats().connections.filter((entry) => [unreadablePath, projectDbPath(valid, paths)].includes(entry.path))).toEqual([]);
    } finally { await daemon.stop(); }
  });

  it("attributes legacy uses within their project group despite an identical id elsewhere", () => {
    const { cwd: here } = checkout("git@github.com:lcm-vote-tests/legacy-group-a.git", []);
    const { cwd: owner, ids } = checkout("git@github.com:lcm-vote-tests/legacy-group-a.git", ["group A memory"]);
    const { cwd: other, ids: otherIds } = checkout("git@github.com:lcm-vote-tests/legacy-group-b.git", ["group B memory"]);
    for (const [cwd, id] of [[owner, ids[0]], [other, otherIds[0]]] as const) {
      const db = new DatabaseSync(projectDbPath(cwd, paths));
      db.prepare("UPDATE promoted SET id = 'shared-legacy-id' WHERE id = ?").run(id);
      db.close();
    }
    const hereDb = new DatabaseSync(projectDbPath(here, paths));
    const store = new PromotedStore(hereDb);
    for (let i = 0; i < 3; i++) {
      store.insert({ content: `legacy use ${i}`, tags: ["signal:memory_used", "memory_id:shared-legacy-id"], projectId: "p1" });
    }
    hereDb.close();

    expect(collectStats(paths).promotionCandidates.filter((candidate) => candidate.id === "shared-legacy-id"))
      .toEqual([expect.objectContaining({ ownerProjectId: projectId(owner), useCount: 3 })]);
  });

  it("continues legacy attribution for a later valid group after a malformed project database", () => {
    const malformedDir = join(base, "projects", "000-malformed");
    mkdirSync(malformedDir, { recursive: true });
    const malformedDb = new DatabaseSync(join(malformedDir, "db.sqlite"));
    malformedDb.exec("CREATE TABLE malformed (value TEXT)");
    malformedDb.close();

    const remote = "git@github.com:lcm-vote-tests/later-valid-group.git";
    const { cwd: requester } = checkout(remote, []);
    const { cwd: owner, ids } = checkout(remote, ["valid owner memory"]);
    const requesterDb = new DatabaseSync(projectDbPath(requester, paths));
    const store = new PromotedStore(requesterDb);
    for (let i = 0; i < 3; i++) {
      store.insert({ content: `legacy use ${i}`, tags: ["signal:memory_used", `memory_id:${ids[0]}`], projectId: "p1" });
    }
    requesterDb.close();

    expect(collectStats(paths).promotionCandidates).toContainEqual(
      expect.objectContaining({ id: ids[0], ownerProjectId: projectId(owner), useCount: 3 }),
    );
  });

  it.each([
    ["signal:memory_used", "used the colliding memory"],
    ["signal:memory_vote", "verified the colliding memory", "vote:+1"],
  ])("rejects an ambiguous %s target without writing a signal", async (signal, text, voteTag?) => {
    const remote = "git@github.com:lcm-vote-tests/ambiguous-signal.git";
    const { cwd: here, ids: hereIds } = checkout(remote, ["here"]);
    const { cwd: sibling, ids: siblingIds } = checkout(remote, ["sibling"]);
    for (const [cwd, id] of [[here, hereIds[0]], [sibling, siblingIds[0]]] as const) {
      const db = new DatabaseSync(projectDbPath(cwd, paths));
      db.prepare("UPDATE promoted SET id = 'colliding-id' WHERE id = ?").run(id);
      db.close();
    }

    const { daemon, port } = await startDaemon();
    try {
      const { status, data } = await postStore(port, {
        cwd: here,
        text,
        tags: [signal, ...(voteTag ? [voteTag] : []), "memory_id:colliding-id"],
      });
      expect(status).toBe(409);
      expect(String(data.error)).toContain("ambiguous");
      for (const cwd of [here, sibling]) {
        const db = new DatabaseSync(projectDbPath(cwd, paths));
        const signals = db.prepare("SELECT COUNT(*) AS count FROM promoted WHERE tags LIKE '%signal:memory_%'").get() as { count: number };
        db.close();
        expect(signals.count).toBe(0);
      }
    } finally {
      await daemon.stop();
    }
  });

  it("reviews an explicitly owned colliding id in its sibling database", async () => {
    const remote = "git@github.com:lcm-vote-tests/review-repo.git";
    const { cwd: here, ids: hereIds } = checkout(remote, ["local memory"]);
    const { cwd: sibling, ids: siblingIds } = checkout(remote, ["sibling memory"]);
    for (const [cwd, id] of [[here, hereIds[0]], [sibling, siblingIds[0]]] as const) {
      const db = new DatabaseSync(projectDbPath(cwd, paths));
      db.prepare("UPDATE promoted SET id = 'colliding-id', created_at = datetime('now', '-120 days') WHERE id = ?").run(id);
      db.close();
    }

    const { daemon, port } = await startDaemon();
    try {
      const list = await postReviewStale(port, { cwd: here });
      expect(list.status).toBe(200);
      const stale = list.data.stale as Array<{ id: string; ownerProjectId: string }>;
      expect(stale.filter((entry) => entry.id === "colliding-id").map((entry) => entry.ownerProjectId).sort())
        .toEqual([projectId(here), projectId(sibling)].sort());
      for (const cwd of [here, sibling]) {
        const db = new DatabaseSync(projectDbPath(cwd, paths));
        const store = new PromotedStore(db);
        for (let i = 0; i < 3; i++) {
          store.insert({ content: `Used colliding memory ${i}`, tags: ["signal:memory_used", "memory_id:colliding-id"], projectId: "p1" });
        }
        db.close();
      }
      expect(collectStats(paths).promotionCandidates.filter((entry) => entry.id === "colliding-id").map((entry) => entry.ownerProjectId).sort())
        .toEqual([projectId(here), projectId(sibling)].sort());

      const ambiguous = await postReviewStale(port, {
        cwd: here, action: "archive", target_id: "colliding-id",
      });
      expect(ambiguous.status).toBe(409);
      expect(String(ambiguous.data.error)).toContain("owner_project_id");
      for (const cwd of [here, sibling]) {
        const db = new DatabaseSync(projectDbPath(cwd, paths));
        const archived = db.prepare("SELECT archived_at FROM promoted WHERE id = 'colliding-id'").get() as { archived_at: string | null };
        db.close();
        expect(archived.archived_at).toBeNull();
      }

      const archive = await postReviewStale(port, {
        cwd: here, action: "archive", target_id: "colliding-id", owner_project_id: projectId(sibling),
      });
      expect(archive.status).toBe(200);
      expect(archive.data.ownerProjectId).toBe(projectId(sibling));

      const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
      const siblingArchived = siblingDb.prepare("SELECT archived_at FROM promoted WHERE id = 'colliding-id'").get() as { archived_at: string | null };
      siblingDb.close();
      expect(siblingArchived.archived_at).not.toBeNull();
      const hereDb = new DatabaseSync(projectDbPath(here, paths));
      const hereArchived = hereDb.prepare("SELECT archived_at FROM promoted WHERE id = 'colliding-id'").get() as { archived_at: string | null };
      hereDb.close();
      expect(hereArchived.archived_at).toBeNull();

      const revive = await postReviewStale(port, {
        cwd: here, action: "revive", target_id: "colliding-id", owner_project_id: projectId(sibling),
      });
      expect(revive.status).toBe(200);
      const revivedDb = new DatabaseSync(projectDbPath(sibling, paths));
      const revived = revivedDb.prepare("SELECT archived_at FROM promoted WHERE id = 'colliding-id'").get() as { archived_at: string | null };
      revivedDb.close();
      expect(revived.archived_at).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  it("scrubs a sibling-bound vote with the sibling's own patterns, not the voter's", async () => {
    const remote = "git@github.com:lcm-vote-tests/scrub-repo.git";
    const { cwd: here } = checkout(remote, []);
    const { cwd: sibling, ids: siblingIds } = checkout(remote, ["compaction runs lazily"]);
    // Only the sibling declares the pattern; the voter's own checkout knows nothing about it.
    writeFileSync(join(projectDir(sibling, paths), "sensitive-patterns.txt"), "hunter2-vote-secret\n");

    const { daemon, port } = await startDaemon();
    try {
      const { status } = await postStore(port, {
        text: "Verified, the token hunter2-vote-secret still works",
        tags: ["signal:memory_vote", "vote:+1", `memory_id:${siblingIds[0]}`],
        cwd: here,
      });
      expect(status).toBe(200);

      const siblingDb = new DatabaseSync(projectDbPath(sibling, paths));
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

      const db = new DatabaseSync(projectDbPath(cwd, paths));
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

      const db = new DatabaseSync(projectDbPath(cwd, paths));
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

      const db = new DatabaseSync(projectDbPath(cwd, paths));
      const counts = new PromotedStore(db).getVoteCounts().get(ids[0]);
      db.close();
      expect(counts?.plusOne).toBe(2);
    } finally {
      await daemon.stop();
    }
  });
});
