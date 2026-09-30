import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { projectId } from "../src/daemon/project.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { findUncompacted, batchCompact } from "../src/batch-compact.js";
import { DaemonClient } from "../src/daemon/client.js";

const tempHomes: string[] = [];

it("replays at most N projects concurrently, preserving each project's chain and ledger order", async () => {
  const { paths } = makeProject();
  const projects = ["a", "b", "c"].map((name) => {
    const cwd = join(paths.home, name);
    const dir = join(paths.projectsDir, projectId(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd }));
    const db = getLcmConnection(join(dir, "db.sqlite"));
    runLcmMigrations(db, { fts5Available: false });
    for (const [index, id] of [`${name}-1`, `${name}-2`].entries()) {
      const conv = createConversation(db, id, `2026-01-0${index + 1}`);
      const message = insertMessage(db, conv, 0, 100);
      insertContextItem(db, conv, 0, "message", message);
    }
    return { cwd, db };
  });
  const gate = Promise.withResolvers<void>();
  const active = new Set<string>();
  let peak = 0;
  const calls: any[] = [];
  const post = vi.spyOn(DaemonClient.prototype, "post").mockImplementation(async (_route, body: any) => {
    expect(active.has(body.cwd)).toBe(false);
    active.add(body.cwd);
    peak = Math.max(peak, active.size);
    calls.push(body);
    await gate.promise;
    active.delete(body.cwd);
    return { replayOutcome: "compacted", latestSummaryId: `sum-${body.session_id}`, latestSummaryContent: `summary-${body.session_id}` } as any;
  });
  const run = batchCompact({ paths, minTokens: 0, dryRun: false, port: 1, replay: true, parallel: 2, replayProvider: "session-pool" });
  try {
    await vi.waitFor(() => expect(peak).toBe(2), { timeout: 300 });
    expect(calls).toHaveLength(2);
    gate.resolve();
    await expect(run).resolves.toMatchObject({ compacted: 6 });
    expect(peak).toBe(2);
    for (const { cwd, db } of projects) {
      const projectCalls = calls.filter((body) => body.cwd === cwd);
      expect(projectCalls.map((body) => body.session_id)).toEqual([`${cwd.slice(-1)}-1`, `${cwd.slice(-1)}-2`]);
      expect(projectCalls[1].previous_summary).toBe(`summary-${projectCalls[0].session_id}`);
      expect(projectCalls.every((body) => body.replay_provider === "session-pool")).toBe(true);
      expect(db.prepare("SELECT session_id, position FROM replay_ledger ORDER BY position").all()).toEqual([
        { session_id: `${cwd.slice(-1)}-1`, position: 0 }, { session_id: `${cwd.slice(-1)}-2`, position: 1 },
      ]);
    }
  } finally {
    gate.resolve();
    await run;
    post.mockRestore();
  }
});

afterEach(() => {
  closeLcmConnection();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeProject() {
  const home = mkdtempSync(join(tmpdir(), "lcm-batch-compact-"));
  tempHomes.push(home);
  const paths = createLcmPaths(home);
  const cwd = join(home, "workspace");
  const projectDir = join(paths.projectsDir, projectId(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }));

  const db = getLcmConnection(join(projectDir, "db.sqlite"));
  runLcmMigrations(db, { fts5Available: false });
  return { paths, cwd, db };
}

function createConversation(db: ReturnType<typeof getLcmConnection>, sessionId: string, updatedAt: string): number {
  const result = db
    .prepare("INSERT INTO conversations (session_id, updated_at) VALUES (?, ?)")
    .run(sessionId, updatedAt);
  return Number(result.lastInsertRowid);
}

function insertMessage(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  seq: number,
  tokenCount: number,
): number {
  const result = db
    .prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', ?, ?)",
    )
    .run(conversationId, seq, `message-${conversationId}-${seq}`, tokenCount);
  return Number(result.lastInsertRowid);
}

function insertSummary(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  summaryId: string,
  messageIds: number[],
): void {
  db.prepare(
    "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', 'summary', 5)",
  ).run(summaryId, conversationId);
  const link = db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)");
  for (const [ordinal, messageId] of messageIds.entries()) {
    link.run(summaryId, messageId, ordinal);
  }
}

function insertContextItem(
  db: ReturnType<typeof getLcmConnection>,
  conversationId: number,
  ordinal: number,
  itemType: "message" | "summary",
  id: number | string,
): void {
  if (itemType === "message") {
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, ordinal, id);
  } else {
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, 'summary', ?)",
    ).run(conversationId, ordinal, id);
  }
}

describe("findUncompacted", () => {
  it("keeps ordinary batch compaction to wholly raw conversations", () => {
    const { paths, cwd, db } = makeProject();

    const partial = createConversation(db, "partial", "2026-01-02");
    const partialCovered = insertMessage(db, partial, 0, 100);
    const partialTailA = insertMessage(db, partial, 1, 6);
    const partialTailB = insertMessage(db, partial, 2, 6);
    insertSummary(db, partial, "sum-partial", [partialCovered]);
    insertContextItem(db, partial, 0, "summary", "sum-partial");
    insertContextItem(db, partial, 1, "message", partialTailA);
    insertContextItem(db, partial, 2, "message", partialTailB);

    const covered = createConversation(db, "covered", "2026-01-01");
    const coveredMessage = insertMessage(db, covered, 0, 100);
    insertSummary(db, covered, "sum-covered", [coveredMessage]);
    insertContextItem(db, covered, 0, "summary", "sum-covered");

    const raw = createConversation(db, "raw", "2026-01-03");
    const rawA = insertMessage(db, raw, 0, 7);
    const rawB = insertMessage(db, raw, 1, 8);
    insertContextItem(db, raw, 0, "message", rawA);
    insertContextItem(db, raw, 1, "message", rawB);

    const smallTail = createConversation(db, "small-tail", "2026-01-04");
    const smallCovered = insertMessage(db, smallTail, 0, 100);
    const smallRaw = insertMessage(db, smallTail, 1, 4);
    insertSummary(db, smallTail, "sum-small-tail", [smallCovered]);
    insertContextItem(db, smallTail, 0, "summary", "sum-small-tail");
    insertContextItem(db, smallTail, 1, "message", smallRaw);

    const candidates = findUncompacted(paths, 10, false, cwd);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["raw"]);
    expect(candidates[0]).toMatchObject({
      messages: 2,
      tokens: 15,
      sourceMessages: 2,
      sourceTokens: 15,
    });

    const replayCandidates = findUncompacted(paths, 10, true, cwd, true);
    expect(replayCandidates.map((candidate) => candidate.sessionId)).toEqual([
      "partial",
      "small-tail",
      "covered",
      "raw",
    ]);
  });

  it("counts only raw messages outside SessionStart's configured fresh tail", () => {
    const { paths, cwd, db } = makeProject();

    const tailOnly = createConversation(db, "tail-only", "2026-01-01");
    const covered = insertMessage(db, tailOnly, 0, 100);
    const tailA = insertMessage(db, tailOnly, 1, 8);
    const tailB = insertMessage(db, tailOnly, 2, 8);
    insertSummary(db, tailOnly, "sum-tail-only", [covered]);
    insertContextItem(db, tailOnly, 0, "summary", "sum-tail-only");
    insertContextItem(db, tailOnly, 1, "message", tailA);
    insertContextItem(db, tailOnly, 2, "message", tailB);

    const eligible = createConversation(db, "eligible", "2026-01-02");
    const eligibleCovered = insertMessage(db, eligible, 0, 100);
    const compactable = insertMessage(db, eligible, 1, 10);
    const eligibleTailA = insertMessage(db, eligible, 2, 8);
    const eligibleTailB = insertMessage(db, eligible, 3, 8);
    insertSummary(db, eligible, "sum-eligible", [eligibleCovered]);
    insertContextItem(db, eligible, 0, "summary", "sum-eligible");
    insertContextItem(db, eligible, 1, "message", compactable);
    insertContextItem(db, eligible, 2, "message", eligibleTailA);
    insertContextItem(db, eligible, 3, "message", eligibleTailB);

    const candidates = findUncompacted(paths, 10, false, cwd, false, { freshTailCount: 2 });

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["eligible"]);
    expect(candidates[0]).toMatchObject({ messages: 1, tokens: 10 });

    const noProtectedTail = findUncompacted(paths, 10, false, cwd, false, { freshTailCount: 0 });
    expect(noProtectedTail.map((candidate) => candidate.sessionId)).toEqual(["eligible", "tail-only"]);
  });

  it("lists only a session's newest conversation: /compact reaches a session through it", () => {
    const { paths, cwd, db } = makeProject();

    // An OMP /clear closed the first conversation and opened the second under the same session id.
    const closed = createConversation(db, "cleared", "2026-01-01");
    insertContextItem(db, closed, 0, "message", insertMessage(db, closed, 0, 50));
    const current = createConversation(db, "cleared", "2026-01-01");
    insertContextItem(db, current, 0, "message", insertMessage(db, current, 0, 20));

    for (const candidates of [
      findUncompacted(paths, 10, false, cwd),
      findUncompacted(paths, 10, false, cwd, false, { freshTailCount: 0 }),
      findUncompacted(paths, 10, true, cwd, true),
    ]) {
      expect(candidates.map((candidate) => candidate.conversationId)).toEqual([current]);
    }
  });
});

describe("batchCompact — daemon becomes unreachable mid-replay", () => {
  let rawServer: Server | undefined;

  afterEach(async () => {
    if (rawServer) {
      await new Promise<void>((r) => rawServer!.close(() => r()));
      rawServer = undefined;
    }
  });

  /** A server that answers /compact once, then tears itself down so the next
   * connection attempt gets a genuine ECONNREFUSED — the same failure mode
   * the daemon produces when it dies mid-run. `Connection: close` forces the
   * client to open a fresh socket for the next request instead of reusing a
   * kept-alive one, so the failure is deterministic rather than a race
   * against Node's connection pool. */
  function startOneShotServer(): Promise<number> {
    rawServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({
          summary: "ok",
          replayOutcome: "compacted",
          latestSummaryContent: `summary-of-${parsed.session_id}`,
          latestSummaryId: `sum-${parsed.session_id}`,
          tokensBefore: 100,
          tokensAfter: 10,
        }));
        res.on("finish", () => {
          rawServer!.closeAllConnections();
          rawServer!.close();
        });
      });
    });
    return new Promise((resolve) => {
      rawServer!.listen(0, "127.0.0.1", () => resolve((rawServer!.address() as AddressInfo).port));
    });
  }

  /** A server that always succeeds — used to prove a rerun resumes cleanly. */
  function startAlwaysUpServer(): Promise<{ port: number; bodies: { session_id: string; skip_ingest?: boolean; previous_summary?: string }[] }> {
    const bodies: { session_id: string; skip_ingest?: boolean; previous_summary?: string }[] = [];
    rawServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        bodies.push({ session_id: parsed.session_id, skip_ingest: parsed.skip_ingest, previous_summary: parsed.previous_summary });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          summary: "ok",
          replayOutcome: "compacted",
          latestSummaryContent: `summary-of-${parsed.session_id}`,
          latestSummaryId: `sum-${parsed.session_id}`,
          tokensBefore: 100,
          tokensAfter: 10,
        }));
      });
    });
    return new Promise((resolve) => {
      rawServer!.listen(0, "127.0.0.1", () => resolve({ port: (rawServer!.address() as AddressInfo).port, bodies }));
    });
  }

  it("stops the run instead of failing every remaining session, and a rerun resumes the chain", async () => {
    const { paths, cwd, db } = makeProject();
    const s1 = createConversation(db, "session-1", "2026-01-01");
    insertMessage(db, s1, 0, 50);
    const s2 = createConversation(db, "session-2", "2026-01-02");
    insertMessage(db, s2, 0, 40);
    const s3 = createConversation(db, "session-3", "2026-01-03");
    insertMessage(db, s3, 0, 30);

    const attempted: string[] = [];
    // Every patch that touches `current`, in order: the session it started
    // ("session-N") or that it cleared ("cleared"). The stop patch must be
    // the last entry and must clear session-2's `current` — otherwise the
    // renderer's final frame keeps showing it as still processing.
    const currentTransitions: string[] = [];
    const port = await startOneShotServer();

    const result = await batchCompact({
      paths, minTokens: 10, dryRun: false, port, cwd, replay: true,
      onProgress: (patch) => {
        if (patch.current) attempted.push(patch.current.sessionId);
        if (!("current" in patch)) return;
        currentTransitions.push(patch.current ? patch.current.sessionId : "cleared");
      },
    });

    // session-1 succeeded; session-2's connection was refused; session-3 was
    // never attempted — the run stopped instead of consuming it.
    expect(attempted).toEqual(["session-1", "session-2"]);
    expect(currentTransitions.slice(-2)).toEqual(["session-2", "cleared"]);
    // The stop is visible to the caller, not just discarded locally — a
    // caller like `lcm compact` can use it to skip a post-batch step (e.g.
    // auto-promote) that would otherwise hit the same unreachable daemon.
    expect(result.daemonUnreachable).toBe(true);

    const ledgerRows = db.prepare("SELECT session_id FROM replay_ledger").all() as { session_id: string }[];
    expect(ledgerRows.map((r) => r.session_id)).toEqual(["session-1"]);

    // The real daemon would have persisted session-1's summary as part of
    // compacting it; the fake server only echoes what it claims to have
    // stored, so recreate that row for the resume plan's chain lookup.
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES ('sum-session-1', ?, 'leaf', 'summary-of-session-1', 5)",
    ).run(s1);

    // Rerun against a healthy daemon: session-2 is retried (not skipped) with
    // session-1's summary still threaded, and session-3 follows it.
    const { port: port2, bodies } = await startAlwaysUpServer();
    await batchCompact({ paths, minTokens: 10, dryRun: false, port: port2, cwd, replay: true });

    expect(bodies.map((b) => b.session_id)).toEqual(["session-2", "session-3"]);
    expect(bodies.map((b) => b.skip_ingest)).toEqual([true, true]);
    expect(bodies[0].previous_summary).toBe("summary-of-session-1");
    expect(bodies[1].previous_summary).toBe("summary-of-session-2");

    const finalLedger = db.prepare("SELECT session_id FROM replay_ledger").all() as { session_id: string }[];
    expect(finalLedger.map((r) => r.session_id).sort()).toEqual(["session-1", "session-2", "session-3"]);
  });

  /** A server that answers session-1's /compact normally, then resets the
   * connection (no response, socket destroyed) for every later request — the
   * failure mode of a daemon that is alive but wedged (event loop blocked)
   * and RSTing everything it cannot service. `resetHealth` controls whether
   * `/health` is one of the things it RSTs. */
  function startWedgedServer(opts: { resetHealth: boolean }): Promise<number> {
    let compactCount = 0;
    rawServer = createServer((req, res) => {
      if (req.url === "/health") {
        if (opts.resetHealth) { req.socket.destroy(); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 1 }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        compactCount++;
        if (compactCount === 1) {
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
          res.end(JSON.stringify({
            summary: "ok",
            replayOutcome: "compacted",
            latestSummaryContent: `summary-of-${parsed.session_id}`,
            latestSummaryId: `sum-${parsed.session_id}`,
            tokensBefore: 100,
            tokensAfter: 10,
          }));
        } else {
          req.socket.destroy();
        }
      });
    });
    return new Promise((resolve) => {
      rawServer!.listen(0, "127.0.0.1", () => resolve((rawServer!.address() as AddressInfo).port));
    });
  }

  it("stops after one failed session when a wedged daemon also fails the health probe", async () => {
    const { paths, cwd, db } = makeProject();
    const s1 = createConversation(db, "session-1", "2026-01-01");
    insertMessage(db, s1, 0, 50);
    const s2 = createConversation(db, "session-2", "2026-01-02");
    insertMessage(db, s2, 0, 40);
    const s3 = createConversation(db, "session-3", "2026-01-03");
    insertMessage(db, s3, 0, 30);

    const attempted: string[] = [];
    const stderrLines: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
      stderrLines.push(args.join(" "));
    });
    const port = await startWedgedServer({ resetHealth: true });
    // See the other stop test: the last two entries must be the session that
    // was in flight when the stop happened, then its explicit clearing.
    const currentTransitions: string[] = [];

    const result = await batchCompact({
      paths, minTokens: 10, dryRun: false, port, cwd, replay: true,
      onProgress: (patch) => {
        if (patch.current) attempted.push(patch.current.sessionId);
        if (!("current" in patch)) return;
        currentTransitions.push(patch.current ? patch.current.sessionId : "cleared");
      },
    });
    consoleErrorSpy.mockRestore();

    // session-3 is never attempted — the run stopped once the probe also failed.
    expect(attempted).toEqual(["session-1", "session-2"]);
    expect(stderrLines.some((l) => l.includes("not answering"))).toBe(true);
    expect(currentTransitions.slice(-2)).toEqual(["session-2", "cleared"]);
    expect(result.daemonUnreachable).toBe(true);

    const ledgerRows = db.prepare("SELECT session_id FROM replay_ledger").all() as { session_id: string }[];
    expect(ledgerRows.map((r) => r.session_id)).toEqual(["session-1"]);
  });

  it("keeps today's behaviour when the health probe answers (compact alone reset)", async () => {
    const { paths, cwd, db } = makeProject();
    const s1 = createConversation(db, "session-1", "2026-01-01");
    insertMessage(db, s1, 0, 50);
    const s2 = createConversation(db, "session-2", "2026-01-02");
    insertMessage(db, s2, 0, 40);
    const s3 = createConversation(db, "session-3", "2026-01-03");
    insertMessage(db, s3, 0, 30);

    const attempted: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await startWedgedServer({ resetHealth: false });

    await batchCompact({
      paths, minTokens: 10, dryRun: false, port, cwd, replay: true,
      onProgress: (patch) => {
        if (patch.current) attempted.push(patch.current.sessionId);
      },
    });
    vi.restoreAllMocks();

    // Every session is still attempted — the run does not stop just because
    // the probe was needed, only when the probe itself fails.
    expect(attempted).toEqual(["session-1", "session-2", "session-3"]);

    const ledgerRows = db.prepare("SELECT session_id FROM replay_ledger").all() as { session_id: string }[];
    expect(ledgerRows.map((r) => r.session_id)).toEqual(["session-1"]);
  });
});
