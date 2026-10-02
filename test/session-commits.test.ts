import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { SessionCapture } from "../src/capture.js";
import { CompactionEngine } from "../src/compaction.js";
import { ScrubEngine } from "../src/scrub.js";
import { backfillProjectCommits } from "../src/session-commits.js";
import { CommitStore } from "../src/store/commit-store.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { enableTimeline } from "../src/db/project-timeline.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";
import { createCommitBackfillHandler } from "../src/daemon/routes/commits.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { projectDbPath, projectDir } from "../src/daemon/project.js";
import { invokeRoute } from "../src/daemon/routes/session-end.js";
import { importSessions } from "../src/import.js";
import type { DaemonClient } from "../src/daemon/client.js";
import { readItems, workFor } from "../src/project-timeline/sources.js";

let db: DatabaseSync;
let capture: SessionCapture;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { claudeProjectsDir: process.env.HOME });
  capture = new SessionCapture(db, "project", new ScrubEngine([], []));
});
afterEach(() => db.close());

function object(dir: string, type: string, content: string): string {
  const bytes = Buffer.from(`${type} ${Buffer.byteLength(content)}\0${content}`);
  const hash = createHash("sha1").update(bytes).digest("hex");
  const folder = join(dir, ".git", "objects", hash.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, hash.slice(2)), deflateSync(bytes));
  return hash;
}

function fixtureCommit(dir: string, message = "Fixture change", authorTime = 1612325106): string {
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/fixture\n");
  const tree = object(dir, "tree", "");
  const hash = object(dir, "commit", `tree ${tree}\nauthor Fixture <fixture@example.invalid> ${authorTime} +0000\ncommitter Fixture <fixture@example.invalid> ${authorTime} +0000\n\n${message}\n`);
  writeFileSync(join(dir, ".git", "refs", "heads", "fixture"), hash + "\n");
  return hash;
}

it("links commit output, anchors only the evidence message, and preserves transcript times", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    const hash = fixtureCommit(dir);
    const output = `[fixture ${hash.slice(0, 7)}] Fixture change`;
    const { records } = await capture.write({ sessionId: "session", messages: [
      { role: "tool", content: output, tokenCount: 20 },
      { role: "user", content: "unknown", tokenCount: 1 },
      { role: "tool", content: output, tokenCount: 20, eventAt: "2022-01-01T00:00:00Z" },
      { role: "assistant", content: output, tokenCount: 20 },
      { role: "tool", content: "[fixture deadbeef] Gone", tokenCount: 5 },
    ] });
    expect(await backfillProjectCommits(db, dir)).toMatchObject({ updated: 1, candidates: 3 });
    const stored = await Promise.all(records.map(record => capture.conversationStore.getMessageById(record.messageId)));
    expect(stored.map(message => [message?.eventAt?.toISOString() ?? null, message?.eventTimeSource ?? null])).toEqual([
      ["2021-02-03T04:05:06.000Z", "commit"], [null, null], ["2022-01-01T00:00:00.000Z", "transcript"], [null, null], [null, null],
    ]);
    expect(new CommitStore(db).forSession("session")).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash, subject: "Fixture change", authorAt: "2021-02-03T04:05:06.000Z", branch: "fixture", resolved: true,
        evidence: "commit-output" }),
      expect.objectContaining({ hash: "deadbeef", resolved: false, authorAt: null }),
    ]));
    const engine = new RetrievalEngine(capture.conversationStore, capture.summaryStore);
    expect(await engine.describe("session")).toMatchObject({ type: "session", commits: expect.arrayContaining([expect.objectContaining({ hash })]) });
    const conversationId = records[0].conversationId;
    await capture.summaryStore.insertSummary({ summaryId: "sum_commit", conversationId, kind: "leaf", content: "Change", tokenCount: 1 });
    await capture.summaryStore.linkSummaryToMessages("sum_commit", [records[0].messageId]);
    expect(await engine.describe("sum_commit")).toMatchObject({ commits: expect.arrayContaining([expect.objectContaining({ hash })]) });
    enableTimeline(db);
    const timeline = openProjectTimeline(db, { summarize: async () => "Timeline", lease: work => withProjectMutation(dir, work) });
    await timeline.settle({ calls: 10 });
    const node = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'period' AND active = 1 LIMIT 1").get() as { summary_id: string };
    expect(timeline.describe(node.summary_id)).toMatchObject({ commits: expect.arrayContaining([expect.objectContaining({ hash })]) });
    expect(await backfillProjectCommits(db, dir)).toMatchObject({ updated: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("matches session trailers through the exact stored URL, never through an lcm session id or prose mention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    const url = "https://claude.ai/code/session_web123";
    const hash = fixtureCommit(dir, `Fixture change\n\nClaude-Session: ${url}`);
    await capture.write({ sessionId: "local123", messages: [{ role: "user", content: `Web session: ${url}`, tokenCount: 10 }] });
    await capture.write({ sessionId: "session_web123", messages: [{ role: "user", content: "no URL", tokenCount: 10 }] });
    expect(await backfillProjectCommits(db, dir, false)).toEqual({ updated: 0, candidates: 0, references: 0 });
    expect(new CommitStore(db).forSession("local123")).toEqual([]);
    expect(await backfillProjectCommits(db, dir)).toMatchObject({ updated: 1 });
    expect(new CommitStore(db).forSession("local123")).toEqual([
      expect.objectContaining({ hash, evidence: "session-trailer", evidenceValue: url, resolved: true }),
    ]);
    expect(new CommitStore(db).forSession("session_web123")).toEqual([]);
    const mentioned = fixtureCommit(dir, `Mention ${url}\n\nNo session trailer here`);
    await backfillProjectCommits(db, dir);
    expect(new CommitStore(db).forSession("local123").map(ref => ref.hash)).not.toContain(mentioned);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("runs the queued commit repair after transcript discovery even when no transcript remains, with an off switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  const paths = createLcmPaths(join(dir, "lcm"));
  try {
    const hash = fixtureCommit(dir);
    mkdirSync(projectDir(dir, paths), { recursive: true });
    const stored = new DatabaseSync(projectDbPath(dir, paths));
    runLcmMigrations(stored, { claudeProjectsDir: dir });
    await new SessionCapture(stored, "project", new ScrubEngine([], []), paths).write({ sessionId: "lost", messages: [
      { role: "tool", content: `[fixture ${hash.slice(0, 7)}] Fixture change`, tokenCount: 10 },
    ] });
    stored.close();
    const config = loadDaemonConfig(join(dir, "missing"));
    const disabled = createCommitBackfillHandler({ ...config, commits: { enabled: false } }, paths);
    expect(await invokeRoute(disabled, { cwd: dir })).toMatchObject({ updated: 0, candidates: 0 });
    const handler = createCommitBackfillHandler(config, paths);
    const post = vi.fn(async (_route, input) => invokeRoute(handler, input));
    const result = await importSessions({ post } as unknown as DaemonClient, {
      paths, cwd: dir, provider: "claude", _claudeProjectsDir: dir, backfillEventTimes: true,
    });
    expect(post.mock.calls).toEqual([["/backfill-commits", { cwd: dir }]]);
    expect(result.backfilledEventTimes).toBe(1);
    const check = new DatabaseSync(projectDbPath(dir, paths), { readOnly: true });
    expect(await new RetrievalEngine(new SessionCapture(check, "project", new ScrubEngine([], [])).conversationStore,
      capture.summaryStore).describe("lost")).toMatchObject({ commits: [expect.objectContaining({ hash, resolved: true })] });
    check.close();
    await importSessions({ post } as unknown as DaemonClient, { paths, cwd: dir, provider: "claude", _claudeProjectsDir: dir,
      backfillEventTimes: true, dryRun: true });
    expect(post).toHaveBeenCalledTimes(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("summary and conversation bounds ignore capture dates when any source time is known", async () => {
  const { conversationId } = await capture.write({ sessionId: "session", messages: [
    { role: "user", content: "dated", tokenCount: 1000, eventAt: "2021-02-03T04:05:06Z" },
    { role: "assistant", content: "unknown", tokenCount: 1000 },
  ] });
  const engine = new CompactionEngine(capture.conversationStore, capture.summaryStore, {
    freshTailCount: 0, leafMinFanout: 1, condensedMinFanout: 10,
  });
  await engine.compact({ conversationId, tokenBudget: 100, force: true, summarize: async () => "Dated summary" });
  const check = async () => {
    const summary = (await capture.summaryStore.getSummariesByConversation(conversationId))[0];
    expect(summary.earliestAt?.toISOString()).toBe("2021-02-03T04:05:06.000Z");
    expect(summary.latestAt?.toISOString()).toBe("2021-02-03T04:05:06.000Z");
    expect(await capture.conversationStore.getConversationTimeBounds(conversationId)).toEqual({
      firstAt: new Date("2021-02-03T04:05:06Z"), lastAt: new Date("2021-02-03T04:05:06Z"),
    });
  };
  await check();
  await capture.summaryStore.recomputeTimeBounds(conversationId);
  await check();
});

it("condensed summary and timeline work bounds prefer known times across separate source items", async () => {
  const { conversationId, records } = await capture.write({ sessionId: "session", messages: [
    { role: "user", content: "known", tokenCount: 10, eventAt: "2021-02-03T04:05:06Z" },
    { role: "assistant", content: "unknown", tokenCount: 10 },
  ] });
  const raw = (await readItems(db, "session"))[0].items;
  expect(workFor(raw, "digest", [], "test")).toMatchObject({ from: "2021-02-03T04:05:06.000Z", to: "2021-02-03T04:05:06.000Z" });
  for (const [index, record] of records.entries()) {
    const id = `sum_leaf${index}`;
    await capture.summaryStore.insertSummary({ summaryId: id, conversationId, kind: "leaf", content: "Leaf", tokenCount: 1,
      earliestAt: record.eventAt ?? record.createdAt, latestAt: record.eventAt ?? record.createdAt });
    await capture.summaryStore.linkSummaryToMessages(id, [record.messageId]);
  }
  await capture.summaryStore.insertSummary({ summaryId: "sum_condensed", conversationId, kind: "condensed", depth: 1, content: "Condensed", tokenCount: 1 });
  await capture.summaryStore.linkSummaryToParents("sum_condensed", ["sum_leaf0", "sum_leaf1"]);
  await capture.summaryStore.recomputeTimeBounds(conversationId);
  expect((await capture.summaryStore.getSummary("sum_condensed"))?.latestAt?.toISOString()).toBe("2021-02-03T04:05:06.000Z");
  const sources = (await readItems(db, "session"))[0].items;
  expect(workFor(sources, "period", [], "test")).toMatchObject({ from: "2021-02-03T04:05:06.000Z", to: "2021-02-03T04:05:06.000Z" });
  db.exec("DELETE FROM summary_backfill");
  runLcmMigrations(db, { claudeProjectsDir: process.env.HOME });
  expect((await capture.summaryStore.getSummary("sum_condensed"))?.latestAt?.toISOString()).toBe("2021-02-03T04:05:06.000Z");
});

it("marks a pruned reference unresolved and never re-resolves an unresolved abbreviation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    const url = "https://claude.ai/code/session_pruned";
    const hash = fixtureCommit(dir, `Fixture change\n\nClaude-Session: ${url}`);
    const { records } = await capture.write({ sessionId: "pruned", messages: [
      { role: "tool", content: `[fixture ${hash.slice(0, 7)}] Fixture change`, tokenCount: 10 },
      { role: "user", content: url, tokenCount: 10 },
    ] });
    await backfillProjectCommits(db, dir);
    expect(new CommitStore(db).forSession("pruned").every(ref => ref.resolved)).toBe(true);
    rmSync(join(dir, ".git", "objects", hash.slice(0, 2), hash.slice(2)));
    await backfillProjectCommits(db, dir);
    expect(new CommitStore(db).forSession("pruned").every(ref => !ref.resolved)).toBe(true);
    expect((await capture.conversationStore.getMessageById(records[0].messageId))?.eventAt).toBeNull();
    await capture.write({ sessionId: "unresolved", messages: [
      { role: "tool", content: `[fixture ${hash.slice(0, 7)}] Fixture change`, tokenCount: 10 },
    ] });
    await backfillProjectCommits(db, dir);
    fixtureCommit(dir, `Fixture change\n\nClaude-Session: ${url}`);
    await backfillProjectCommits(db, dir);
    expect(new CommitStore(db).forSession("unresolved")).toMatchObject([{ hash: hash.slice(0, 7), resolved: false, authorAt: null }]);
    expect(new CommitStore(db).forSession("pruned").every(ref => !ref.resolved)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a commit anchor tied to surviving evidence when one of two commits is pruned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    const first = fixtureCommit(dir);
    const second = fixtureCommit(dir, "Later change", 1640995200);
    const { records } = await capture.write({ sessionId: "session", messages: [{ role: "tool",
      content: `[fixture ${first.slice(0, 7)}] Fixture change\n[fixture ${second.slice(0, 7)}] Later change`, tokenCount: 20 }] });
    await backfillProjectCommits(db, dir);
    rmSync(join(dir, ".git", "objects", first.slice(0, 2), first.slice(2)));
    await backfillProjectCommits(db, dir);
    expect(await capture.conversationStore.getMessageById(records[0].messageId)).toMatchObject({
      eventAt: new Date("2022-01-01T00:00:00Z"), eventTimeSource: "commit",
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads only prefiltered candidate messages in bounded pages and yields between them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    fixtureCommit(dir);
    await capture.write({ sessionId: "quiet", messages: Array.from({ length: 1200 }, () => ({ role: "user", content: "ordinary history", tokenCount: 1 })) });
    await capture.write({ sessionId: "candidates", messages: Array.from({ length: 300 }, () => ({ role: "tool", content: "commit bogus", tokenCount: 1 })) });
    const rows: number[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("AS tool_output") || sql.includes(") tool_output")) {
        expect(sql).toContain("LIKE");
        expect(sql).toContain("LIMIT 256");
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          const result = all(...args);
          rows.push(result.length);
          return result;
        });
      }
      return statement;
    });
    let yielded = false;
    setImmediate(() => { yielded = true; });
    expect(await backfillProjectCommits(db, dir)).toMatchObject({ candidates: 300, updated: 0 });
    spy.mockRestore();
    expect(rows).toEqual([256, 44]);
    expect(yielded).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ["[fixture (root-commit) HASH] Fixture change", "fixture"],
  ["[detached HEAD HASH] Fixture change", null],
  ["commit FULL", null],
  ["HASH Fixture change", null],
  ["FULL", null],
  ['{"output":"[fixture HASH] Fixture change\\n"}', "fixture"],
] as const)("recognizes commit output form %s", async (form, branch) => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-commit-fixture-"));
  try {
    const hash = fixtureCommit(dir);
    const content = form.replace("HASH", hash.slice(0, 7)).replace("FULL", hash);
    const conversation = await capture.conversationStore.getOrCreateConversation("session");
    await capture.conversationStore.createMessage({ conversationId: conversation.conversationId, seq: 0, role: "tool", content, tokenCount: 10 });
    await backfillProjectCommits(db, dir);
    expect(new CommitStore(db).forSession("session")).toMatchObject([{ hash, branch, resolved: true }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
