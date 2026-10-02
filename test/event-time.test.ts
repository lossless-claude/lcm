import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { createIngestHandler } from "../src/daemon/routes/ingest.js";
import { invokeRoute } from "../src/daemon/routes/session-end.js";
import { projectDbPath, projectDir } from "../src/daemon/project.js";
import { SessionCapture, markSessionComplete } from "../src/capture.js";
import { applyCutRowRepair, planCutRowRepair } from "../src/cut-row-repair.js";
import { importSessions } from "../src/import.js";
import { claudeProjectSlug } from "../src/daemon/project.js";
import type { DaemonClient } from "../src/daemon/client.js";
import { backfillSessionEventTimes } from "../src/event-time-backfill.js";
import { searchNativeHistory } from "../src/search/native-history.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { enableTimeline } from "../src/db/project-timeline.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";
import { CompactionEngine } from "../src/compaction.js";
import { ScrubEngine } from "../src/scrub.js";

describe("transcript event time", () => {
  let db: DatabaseSync;
  let dir: string;
  let capture: SessionCapture;
  const at = "2021-02-03T04:05:06.123Z";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lcm-event-time-"));
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { claudeProjectsDir: dir });
    capture = new SessionCapture(db, "project", new ScrubEngine([], []));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["claude", "codex", "omp"])("imports %s record time separately from capture time", async client => {
    const path = join(dir, "session.jsonl");
    const entries = client === "claude"
      ? [{ timestamp: at, message: { role: "user", content: "old history" } }]
      : client === "codex"
        ? [{ type: "session_meta", payload: { id: "session", cwd: dir } },
            { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: "old history" } }]
        : [{ type: "session", id: "session", cwd: dir },
            { type: "message", id: "turn", parentId: null, timestamp: at, message: { role: "user", content: "old history" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const result = await capture.captureTranscript({ sessionId: "session", cwd: dir, transcriptPath: path, client, source: "import" });
    expect(result?.records).toHaveLength(1);
    expect(result!.records[0].eventAt?.toISOString()).toBe(at);
    expect(result!.records[0].createdAt.getTime()).toBeGreaterThan(Date.parse("2022-01-01"));
    expect((await capture.conversationStore.getMessageById(result!.records[0].messageId))?.eventAt?.toISOString()).toBe(at);
  });
  it("derives summary and conversation bounds from event time with capture fallback", async () => {
    const { conversationId, records } = await capture.write({ sessionId: "session", messages: [
      { role: "user", content: "old first", tokenCount: 1000, eventAt: "2021-02-01T00:00:00Z" },
      { role: "assistant", content: "old last", tokenCount: 1000, eventAt: at },
    ] });
    const engine = new CompactionEngine(capture.conversationStore, capture.summaryStore, {
      freshTailCount: 0, leafMinFanout: 1, condensedMinFanout: 10,
    });
    await engine.compact({ conversationId, tokenBudget: 100, force: true, summarize: async () => "Old conversation summary" });
    const summaries = await capture.summaryStore.getSummariesByConversation(conversationId);
    expect(summaries[0].earliestAt?.toISOString()).toBe("2021-02-01T00:00:00.000Z");
    expect(summaries[0].latestAt?.toISOString()).toBe(at);
    const conversation = await capture.conversationStore.getConversationTimeBounds(conversationId);
    expect(conversation?.firstAt?.toISOString()).toBe("2021-02-01T00:00:00.000Z");
    expect(conversation?.lastAt?.toISOString()).toBe(at);
    const unknown = await capture.write({ sessionId: "unknown", messages: [{ role: "user", content: "no timestamp", tokenCount: 1 }] });
    expect(unknown.records[0].eventAt).toBeNull();
    expect((await capture.conversationStore.getConversationTimeBounds(unknown.conversationId))?.firstAt?.toISOString()).toBe(unknown.records[0].createdAt.toISOString());
    expect(records[0].createdAt.getTime()).toBeGreaterThan(Date.parse(at));
  });
  it("backfills only an aligned prefix, resumes after a missing middle is restored, and recomputes summaries", async () => {
    const messages = ["first", "middle", "last"].map(content => ({ role: "user", content, tokenCount: 1 }));
    const { conversationId, records } = await capture.write({ sessionId: "session", messages });
    const summaries = capture.summaryStore;
    await summaries.insertSummary({ summaryId: "leaf", conversationId, kind: "leaf", content: "old bounds", tokenCount: 1,
      earliestAt: records[0].createdAt, latestAt: records[2].createdAt });
    await summaries.linkSummaryToMessages("leaf", records.map(record => record.messageId));
    await summaries.insertSummary({ summaryId: "condensed", conversationId, kind: "condensed", depth: 1, content: "parent bounds", tokenCount: 1,
      earliestAt: records[0].createdAt, latestAt: records[2].createdAt });
    await summaries.linkSummaryToParents("condensed", ["leaf"]);
    const path = join(dir, "session.jsonl");
    const entries = ["first", "middle", "last"].map((content, index) => ({ timestamp: `2021-02-0${index + 1}T00:00:00Z`, message: { role: "user", content } }));
    const write = (entries: unknown[]) => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const input = { sessionId: "session", cwd: dir, transcriptPath: path, client: "claude" as const, source: "import" as const };
    write([entries[0], entries[2]]);
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 1, unknown: 2 });
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.eventAt?.toISOString() ?? null))
      .toEqual(["2021-02-01T00:00:00.000Z", null, null]);
    write(entries);
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 2, unknown: 0 });
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 0, unknown: 0 });
    for (const id of ["leaf", "condensed"]) {
      const summary = await summaries.getSummary(id);
      expect(summary?.earliestAt?.toISOString()).toBe("2021-02-01T00:00:00.000Z");
      expect(summary?.latestAt?.toISOString()).toBe("2021-02-03T00:00:00.000Z");
    }
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.createdAt))
      .toEqual(records.map(record => record.createdAt));
  });

  it.each(["claude", "codex", "omp"])("keeps %s times unknown when its transcript is gone or its prefix does not align", async client => {
    await capture.write({ sessionId: "session", messages: [{ role: "user", content: "original", tokenCount: 1 }] });
    const path = join(dir, "session.jsonl");
    const input = { sessionId: "session", cwd: dir, transcriptPath: path, client };
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 0, unknown: 1 });
    const entries = client === "claude" ? [{ timestamp: at, message: { role: "user", content: "different" } }]
      : client === "codex" ? [{ type: "session_meta", payload: { id: "session", cwd: dir } }, { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: "different" } }]
      : [{ type: "session", id: "session", cwd: dir }, { type: "message", id: "turn", parentId: null, timestamp: at, message: { role: "user", content: "different" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 0, unknown: 1 });
    expect((await capture.conversationStore.getSessionMessages("session"))[0].eventAt).toBeNull();
  });
  it("routes explicit import backfill to repair without compaction or promotion", async () => {
    const project = join(dir, claudeProjectSlug(dir));
    mkdirSync(project);
    writeFileSync(join(project, "session.jsonl"), JSON.stringify({ timestamp: at, message: { role: "user", content: "old" } }) + "\n");
    const post = vi.fn(async () => ({ ingested: 0, totalTokens: 0, backfilledEventTimes: 1, unknownEventTimes: 0 }));
    const result = await importSessions({ post } as unknown as DaemonClient, { cwd: dir, provider: "claude", _claudeProjectsDir: dir, backfillEventTimes: true });
    expect(post.mock.calls).toHaveLength(2);
    expect(post.mock.calls[0]).toEqual(["/ingest", expect.objectContaining({ backfill_event_times: true, session_id: "session" })]);
    expect(post.mock.calls[1]).toEqual(["/backfill-commits", { cwd: dir }]);
    expect(result.backfilledEventTimes).toBe(1);
  });
  it("repairs a completed session through ingest without capturing a new tail", async () => {
    const paths = createLcmPaths(join(dir, "lcm"));
    mkdirSync(projectDir(dir, paths), { recursive: true });
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [{ timestamp: at, message: { role: "user", content: "original" } },
      { timestamp: at, message: { role: "assistant", content: "uncaptured tail" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const stored = new DatabaseSync(projectDbPath(dir, paths));
    try {
      runLcmMigrations(stored, { claudeProjectsDir: dir });
      await new SessionCapture(stored, "project", new ScrubEngine([], [])).write({ sessionId: "session", messages: [{ role: "user", content: "original", tokenCount: 1 }] });
      markSessionComplete(stored, "session", 1);
    } finally { stored.close(); }
    const result = await invokeRoute(createIngestHandler(loadDaemonConfig(join(dir, "missing-config")), paths), {
      session_id: "session", cwd: dir, transcript_path: path, source: "import", backfill_event_times: true,
    });
    expect(result).toMatchObject({ ingested: 0, backfilledEventTimes: 1, unknownEventTimes: 0 });
    const check = new DatabaseSync(projectDbPath(dir, paths), { readOnly: true });
    try {
      expect(check.prepare("SELECT content, event_at FROM messages").all()).toEqual([{ content: "original", event_at: at }]);
    } finally { check.close(); }
  });
  it("assigns imported sessions to event months", async () => {
    enableTimeline(db);
    await capture.write({ sessionId: "session", messages: [{ role: "user", content: "old event", tokenCount: 1, eventAt: at }] });
    const timeline = openProjectTimeline(db, { summarize: async () => "Dated event", lease: work => withProjectMutation(dir, work) });
    await timeline.settle({ calls: 10 });
    const node = db.prepare("SELECT summary_id, period_from FROM timeline_nodes WHERE level = 'period' AND active = 1").get() as { summary_id: string; period_from: string };
    expect(node.period_from).toBe(at);
    expect(timeline.describe(node.summary_id)?.coverage[0]).toMatchObject({ sessionId: "session", timeBasis: "event" });
  });

  it("marks capture-time fallback in timeline metadata and generation sources", async () => {
    enableTimeline(db);
    const result = await capture.write({ sessionId: "unknown", messages: [{ role: "user", content: "undated event", tokenCount: 1 }] });
    const summarize = vi.fn(async (_text: string) => "Undated history");
    const timeline = openProjectTimeline(db, { summarize, lease: work => withProjectMutation(dir, work) });
    await timeline.settle({ calls: 10 });
    const node = db.prepare("SELECT summary_id, period_from FROM timeline_nodes WHERE level = 'period' AND active = 1").get() as { summary_id: string; period_from: string };
    expect(node.period_from).toBe(result.records[0].createdAt.toISOString());
    expect(timeline.describe(node.summary_id)?.coverage[0]).toMatchObject({ sessionId: "unknown", timeBasis: "capture" });
    expect(summarize.mock.calls[0][0]).toContain("capture time; event time unknown");
  });
  it("keeps capture fallback visible in timeline search results", async () => {
    enableTimeline(db);
    await capture.write({ sessionId: "unknown", messages: [{ role: "user", content: "undated history", tokenCount: 1 }] });
    const timeline = openProjectTimeline(db, { summarize: async () => "undated history", lease: work => withProjectMutation(dir, work) });
    await timeline.settle({ calls: 10 });
    const hits = await searchNativeHistory(db, { query: "undated", limit: 20, project: { id: "project", cwd: dir } });
    expect(hits.filter(hit => hit.timeline).map(hit => hit.timeline?.timeBasis)).toEqual(["capture", "capture"]);
  });
  it.each(["codex", "omp"] as const)("preserves %s event time when rebuilding a historical cut row", async client => {
    const { records } = await capture.write({ sessionId: "session", messages: [{ role: "user", content: "before", tokenCount: 1 }] });
    const path = join(dir, "session.jsonl");
    const entries = client === "codex"
      ? [{ type: "session_meta", payload: { id: "session", cwd: dir } }, { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: "before\u0000after" } }]
      : [{ type: "session", id: "session", cwd: dir }, { type: "message", id: "turn", parentId: null, timestamp: at, message: { role: "user", content: "before\u0000after" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const plan = await planCutRowRepair(db, { sessionId: "session", cwd: dir, client, transcriptPath: path, scrub: text => text });
    expect(plan.kind).toBe("repairable");
    expect(applyCutRowRepair(db, plan)).toBe(1);
    const repaired = await capture.conversationStore.getMessageById(records[0].messageId);
    expect(repaired?.content).toBe("before�after");
    expect(repaired?.eventAt?.toISOString()).toBe(at);
    expect(repaired?.createdAt).toEqual(records[0].createdAt);
  });
  it("backfills OMP history across a rewind only when file-order matches are unambiguous", async () => {
    const messages = ["root", "abandoned", "live"].map(content => ({ role: "user", content, tokenCount: 1 }));
    await capture.write({ sessionId: "session", messages });
    const path = join(dir, "session.jsonl");
    const entries = [{ type: "session", id: "session", cwd: dir },
      { type: "message", id: "root", parentId: null, timestamp: "2021-02-01T00:00:00Z", message: { role: "user", content: "root" } },
      { type: "message", id: "old", parentId: "root", timestamp: "2021-02-02T00:00:00Z", message: { role: "user", content: "abandoned" } },
      { type: "message", id: "new", parentId: "root", timestamp: "2021-02-03T00:00:00Z", message: { role: "user", content: "live" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const input = { sessionId: "session", cwd: dir, transcriptPath: path, client: "omp" as const, source: "import" as const };
    expect(await backfillSessionEventTimes(db, input, new ScrubEngine([], []))).toEqual({ updated: 3, unknown: 0 });
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.eventAt?.toISOString())).toEqual([
      "2021-02-01T00:00:00.000Z", "2021-02-02T00:00:00.000Z", "2021-02-03T00:00:00.000Z",
    ]);
  });

  it("bounds scrubbing for a large misaligned OMP session", async () => {
    const count = 2000;
    const messages = Array.from({ length: count }, (_, index) => ({ role: "user", content: `message ${index}`, tokenCount: 1 }));
    await capture.write({ sessionId: "session", messages });
    const path = join(dir, "session.jsonl");
    const entries = [{ type: "session", id: "session", cwd: dir },
      ...messages.map((message, index) => ({ type: "message", id: `turn-${index}`, parentId: index ? `turn-${index - 1}` : null, timestamp: at, message })),
      { type: "message", id: "rewind", parentId: "turn-0", timestamp: at, message: { role: "user", content: "uncaptured branch" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const scrubber = new ScrubEngine([], []);
    const original = scrubber.scrubWithCounts.bind(scrubber);
    let calls = 0;
    scrubber.scrubWithCounts = text => { calls++; return original(text); };
    expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client: "omp" }, scrubber))
      .toEqual({ updated: count, unknown: 0 });
    expect(calls).toBeLessThanOrEqual(12 * count);
  }, 60_000);

  it.each([
    { stored: "before", current: ["before\u0000after"], updated: 2, unknown: 0 },
    { stored: "before�after", current: ["before\u0000after"], updated: 2, unknown: 0 },
    { stored: "token [REDACTED] end", current: ["token secret end"], updated: 2, unknown: 0 },
    { stored: "token [REDACTED] end", current: ["token first end", "token second end"], updated: 1, unknown: 1 },
  ])("preserves exceptional file-order matches: $stored / $current", async ({ stored, current, updated, unknown }) => {
    await capture.write({ sessionId: "session", messages: ["root", stored].map(content => ({ role: "user", content, tokenCount: 1 })) });
    const path = join(dir, "session.jsonl");
    const entries = [{ type: "session", id: "session", cwd: dir },
      ...["root", ...current].map((content, index) => ({ type: "message", id: `turn-${index}`, parentId: index ? `turn-${index - 1}` : null, timestamp: at, message: { role: "user", content } })),
      { type: "message", id: "rewind", parentId: "turn-0", timestamp: at, message: { role: "assistant", content: "other branch" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client: "omp" }, new ScrubEngine([], [])))
      .toEqual({ updated, unknown });
  });

  it("bounds historical redaction comparisons and leaves an unproven suffix unknown", async () => {
    const count = 100;
    const messages = Array.from({ length: count }, (_, index) => ({ role: "user", content: index ? `message ${index} [REDACTED]` : "root", tokenCount: 1 }));
    await capture.write({ sessionId: "session", messages });
    const path = join(dir, "session.jsonl");
    const entries = [{ type: "session", id: "session", cwd: dir },
      ...messages.map((message, index) => ({ type: "message", id: `turn-${index}`, parentId: index ? `turn-${index - 1}` : null, timestamp: at, message: { ...message, content: message.content.replace("[REDACTED]", "secret") } })),
      { type: "message", id: "rewind", parentId: "turn-0", timestamp: at, message: { role: "assistant", content: "other branch" } }];
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const scrubber = new ScrubEngine([], []);
    const original = scrubber.scrubWithCounts.bind(scrubber);
    let calls = 0;
    scrubber.scrubWithCounts = text => { calls++; return original(text); };
    const result = await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client: "omp" }, scrubber);
    expect(result.updated).toBeGreaterThan(1);
    expect(result.unknown).toBeGreaterThan(0);
    expect(result.updated + result.unknown).toBe(count);
    expect(calls).toBeLessThanOrEqual(20 * count);
    const repaired = await capture.conversationStore.getSessionMessages("session");
    expect(repaired.slice(0, result.updated).every(message => message.eventAt?.toISOString() === at)).toBe(true);
    expect(repaired.slice(result.updated).every(message => message.eventAt === null)).toBe(true);
  });

  it("yields between bounded repair batches and preserves positions across clears and compaction events", async () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({ role: "user", content: `message ${index}`, tokenCount: 1 }));
    const { conversationId } = await capture.write({ sessionId: "session", messages, boundaries: [{ entryId: "clear", at: 300 }] });
    const event = await capture.conversationStore.createMessage({ conversationId, seq: 300, role: "system", content: "internal compaction", tokenCount: 1 });
    await capture.conversationStore.createMessageParts(event.messageId, [{ sessionId: "session", ordinal: 0, partType: "compaction" }]);
    const path = join(dir, "session.jsonl");
    writeFileSync(path, messages.map(message => JSON.stringify({ timestamp: at, message })).join("\n") + "\n");
    const batches: number[] = [];
    const original = capture.conversationStore.sessionMessagePages;
    const spy = vi.spyOn(Object.getPrototypeOf(capture.conversationStore), "sessionMessagePages").mockImplementation(async function* (session: string, limit: number) {
      for await (const page of original.call(this, session, limit)) {
        batches.push(page.length);
        yield page;
      }
    });
    let yielded = false;
    setImmediate(() => { yielded = true; });
    try {
      expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path }, new ScrubEngine([], []))).toEqual({ updated: 600, unknown: 0 });
      expect(yielded).toBe(true);
      expect(Math.max(...batches)).toBeLessThanOrEqual(256);
      expect((await capture.conversationStore.getMessageById(event.messageId))?.eventAt).toBeNull();
    } finally { spy.mockRestore(); }
  });
  it("leaves repeated OMP branch matches unknown instead of guessing their timestamps", async () => {
    await capture.write({ sessionId: "session", messages: ["root", "repeated", "repeated"].map(content => ({ role: "user", content, tokenCount: 1 })) });
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [{ type: "session", id: "session", cwd: dir },
      { type: "message", id: "root", parentId: null, timestamp: "2021-02-01T00:00:00Z", message: { role: "user", content: "root" } },
      { type: "message", id: "old", parentId: "root", timestamp: "2021-02-02T00:00:00Z", message: { role: "user", content: "repeated" } },
      { type: "message", id: "new", parentId: "root", timestamp: "2021-02-03T00:00:00Z", message: { role: "user", content: "repeated" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    expect(await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path, client: "omp" }, new ScrubEngine([], []))).toEqual({ updated: 1, unknown: 2 });
  });

  it("rebuilds Claude history with transcript event timestamps", async () => {
    await capture.write({ sessionId: "session", messages: ["first", "last"].map(content => ({ role: "user", content, tokenCount: 1 })) });
    const path = join(dir, "session.jsonl");
    writeFileSync(path, ["first", "middle", "last"].map(content => JSON.stringify({ timestamp: at, message: { role: "user", content } })).join("\n") + "\n");
    expect(await capture.rebuildTranscript({ sessionId: "session", cwd: dir, transcriptPath: path })).toMatchObject({ ingested: 3, plan: { kind: "repairable" } });
    expect((await capture.conversationStore.getSessionMessages("session")).map(message => message.eventAt?.toISOString())).toEqual([at, at, at]);
  });

  it("replans capture-month timeline nodes after event-time backfill", async () => {
    enableTimeline(db);
    await capture.write({ sessionId: "session", messages: [{ role: "user", content: "old history", tokenCount: 1 }] });
    const timeline = openProjectTimeline(db, { summarize: async () => "dated history", lease: work => withProjectMutation(dir, work) });
    await timeline.settle({ calls: 10 });
    const prior = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'period' AND active = 1").get() as { summary_id: string };
    const path = join(dir, "session.jsonl");
    writeFileSync(path, JSON.stringify({ timestamp: at, message: { role: "user", content: "old history" } }) + "\n");
    await backfillSessionEventTimes(db, { sessionId: "session", cwd: dir, transcriptPath: path }, new ScrubEngine([], []));
    await timeline.settle({ calls: 0 });
    expect(timeline.describe(prior.summary_id)?.stale).not.toBeNull();
    await timeline.settle({ calls: 10 });
    const current = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'period' AND active = 1 AND stale_reason IS NULL").all() as Array<{ summary_id: string }>;
    expect(current).toHaveLength(1);
    expect(timeline.describe(current[0].summary_id)?.period).toEqual({ from: at, to: at });
  });
});
