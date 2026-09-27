import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { projectId } from "../src/daemon/project.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { findUncompacted, batchCompact } from "../src/batch-compact.js";

const tempHomes: string[] = [];

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
  function startAlwaysUpServer(): Promise<{ port: number; bodies: { session_id: string; previous_summary?: string }[] }> {
    const bodies: { session_id: string; previous_summary?: string }[] = [];
    rawServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        bodies.push({ session_id: parsed.session_id, previous_summary: parsed.previous_summary });
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
    const port = await startOneShotServer();

    await batchCompact({
      paths, minTokens: 10, dryRun: false, port, cwd, replay: true,
      onProgress: (patch) => {
        if (patch.current) attempted.push(patch.current.sessionId);
      },
    });

    // session-1 succeeded; session-2's connection was refused; session-3 was
    // never attempted — the run stopped instead of consuming it.
    expect(attempted).toEqual(["session-1", "session-2"]);

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
    expect(bodies[0].previous_summary).toBe("summary-of-session-1");
    expect(bodies[1].previous_summary).toBe("summary-of-session-2");

    const finalLedger = db.prepare("SELECT session_id FROM replay_ledger").all() as { session_id: string }[];
    expect(finalLedger.map((r) => r.session_id).sort()).toEqual(["session-1", "session-2", "session-3"]);
  });
});
