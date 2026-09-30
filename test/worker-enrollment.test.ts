import { CompactionEngine, compactEngineConfig } from "../src/compaction.js";
import { createPromoteHandler } from "../src/daemon/routes/promote.js";
import { createWorkerSessionHandler } from "../src/daemon/routes/worker-session.js";
import { dispatchCodexHook } from "../src/hooks/codex.js";
import { SessionCapture } from "../src/capture.js";
import { ScrubEngine } from "../src/scrub.js";
import { createIngestHandler } from "../src/daemon/routes/ingest.js";
import { acquireProjectMutation } from "../src/daemon/project-queue.js";
import { projectId } from "../src/daemon/project.js";
import { collectStats, printStats } from "../src/stats.js";
import { createStatusHandler } from "../src/daemon/routes/status.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { invokeRoute } from "../src/daemon/routes/session-end.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLcmPaths } from "../src/lcm-paths.js";
import { registerWorkerSession } from "../src/worker-session.js";
import { recordPostToolEvents } from "../src/hooks/tool-events.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { eventsDbPath } from "../src/db/events-path.js";
import { getLcmConnection, closeLcmConnection } from "../src/db/connection.js";
import { claudeTranscriptPath, projectDbPath } from "../src/daemon/project.js";
import { WorkerStore } from "../src/store/worker-store.js";
import { PromotedStore } from "../src/db/promoted.js";
import * as subagentDiscovery from "../src/subagent-attribution.js";
import { discoverWorkerDescendant, workerExcluded } from "../src/worker-session.js";
import { scanForTranscripts } from "../src/daemon/server.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("registration preserves existing sidecar canaries and gates a fresh session after reopening", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-test-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const event = { session_id: "worker", cwd, tool_name: "Bash", tool_input: { command: 'git commit -m "FOREIGN_CANARY_685"' } };
  expect(recordPostToolEvents(event, paths).recorded).toBeGreaterThan(0);
  await expect(registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" })).rejects.toThrow("existing tool events");
  await registerWorkerSession(paths, { sessionId: "fresh", cwd, client: "claude", owner: "hook" });
  expect(recordPostToolEvents({ ...event, session_id: "fresh" }, paths).recorded).toBe(0);
  const edb = new EventsDb(eventsDbPath(cwd, paths));
  expect(edb.getUnprocessed()).toHaveLength(1); edb.close();
  const dbPath = projectDbPath(cwd, paths);
  const db = getLcmConnection(dbPath);
  expect(new WorkerStore(db).live("fresh", cwd, "claude")).toBe(true);
  closeLcmConnection(dbPath);
  const reopened = getLcmConnection(dbPath);
  expect(new WorkerStore(reopened).excluded("fresh")).toBe(true);
  closeLcmConnection(dbPath);
});

it("reports durable enrollment and last activity even when the excluded project has no messages", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-status-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "codex", owner: "hook" });
  const stats = collectStats(paths);
  expect(stats.workers).toEqual([expect.objectContaining({ session_id: "worker", state: "active", last_activity: expect.any(String) })]);
  const status = await invokeRoute<{ project: { workers: unknown[]; workerWarning: string } }>(
    createStatusHandler(loadDaemonConfig("/nonexistent", {}, {}), paths, Date.now()), { cwd });
  expect(status.project.workers).toHaveLength(1);
  expect(status.project.workerWarning).toContain("transcript stays on disk");
});

it("checks command-hook enrollment without registering a function-hook owner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-check-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const check = createWorkerSessionHandler(paths);
  const input = { cwd, session_id: "worker", client: "claude", declared: true, action: "check" };
  expect(await invokeRoute(check, input)).toMatchObject({ enrolled: false, reason: expect.stringContaining("command-hook enrollment") });
  expect(collectStats(paths).workers).toEqual([]);
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "native-owner" });
  expect(await invokeRoute(check, input)).toMatchObject({ enrolled: true, warning: expect.stringContaining("not recorded by lcm") });
  expect(await invokeRoute(check, { ...input, client: "codex" })).toMatchObject({ enrolled: false });
  await (await import("../src/worker-session.js")).finishWorkerSession(paths, cwd, "worker");
  expect(await invokeRoute(check, input)).toMatchObject({ enrolled: false });
});

it("a capture racing registration cannot write a foreign-content canary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-race-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const lease = await acquireProjectMutation(projectId(cwd));
  const registration = registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" });
  const ingest = invokeRoute(createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths), {
    cwd, session_id: "worker", messages: [{ role: "user", content: "FOREIGN_RACING_CANARY_685", tokenCount: 10 }],
  });
  lease.release();
  await registration; await ingest;
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(db.prepare("SELECT * FROM messages").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM messages_fts").all()).toEqual([]);
  } finally { closeLcmConnection(path); }
});

it.each(["ingest", "scan"])("disk-discovered worker descendants lose captured history and sidecar canaries through %s", async source => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-recovery-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await registerWorkerSession(paths, { sessionId: "root", cwd, client: "claude", owner: "hook" });
  recordPostToolEvents({ cwd, session_id: "agent-fork", tool_name: "Bash", tool_input: { command: 'git commit -m "FOREIGN_RECOVERY_CANARY_685"' } }, paths);
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    const capture = new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths);
    const old = await capture.write({ sessionId: "agent-fork", messages: [{ role: "assistant", content: "FOREIGN_RECOVERY_CANARY_685", tokenCount: 100,
      parts: [{ type: "text", text: "FOREIGN_RECOVERY_CANARY_685" }] }] });
    const compacted = await new CompactionEngine(capture.conversationStore, capture.summaryStore,
      { ...compactEngineConfig({ env: {} }), freshTailCount: 0, leafMinFanout: 1 }).compact({
        conversationId: old.conversationId, tokenBudget: 100, force: true, summarize: async () => "FOREIGN_RECOVERY_CANARY_685",
      });
    expect(compacted.actionTaken).toBe(true);
    const promoted = await invokeRoute<{ promoted: number }>(createPromoteHandler(loadDaemonConfig("/nonexistent",
      { compaction: { promotionThresholds: { minDepth: 0 } } }, {}), paths), { cwd });
    expect(promoted.promoted).toBeGreaterThan(0);
    expect(db.prepare("SELECT * FROM message_parts").all().length).toBeGreaterThan(0);
    const root = claudeTranscriptPath(realpathSync(cwd), "root")!;
    const childDir = join(dirname(root), "root", "subagents", "workflows");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(root, "{}\n");
    writeFileSync(join(childDir, "agent-fork.jsonl"), "{}\n");
    expect(discoverWorkerDescendant(new WorkerStore(db), "agent-fork", join(childDir, "agent-fork.jsonl"))).toBe(realpathSync(cwd));
    const nativeDiscovery = subagentDiscovery.discoverSubagentTranscripts;
    const discovery = vi.spyOn(subagentDiscovery, "discoverSubagentTranscripts");
    discovery.mockImplementation((...args) => {
      expect(db.isTransaction).toBe(false);
      return nativeDiscovery(...args);
    });
    try {
      const config = loadDaemonConfig("/nonexistent", {}, {});
      const ingest = createIngestHandler(config, paths);
      if (source === "scan") await scanForTranscripts(config, paths, ingest);
      else expect(await invokeRoute(ingest, { cwd, session_id: "root", messages: [{ role: "user", content: "ignored", tokenCount: 1 }] }))
        .toMatchObject({ ingested: 0 });
      expect(discovery).toHaveBeenCalled();
      expect(new WorkerStore(db).excluded("agent-fork")).toBe(true);
      discovery.mockClear();
      expect(workerExcluded(cwd, "agent-fork", paths)).toBe(true);
      expect((await capture.write({ sessionId: "agent-fork", messages: [{ role: "user", content: "new content", tokenCount: 1 }] })).records)
        .toEqual([]);
      expect(discovery).not.toHaveBeenCalled();
    } finally { discovery.mockRestore(); }
    for (const table of ["messages", "message_parts", "summaries", "messages_fts", "summaries_fts", "promoted", "promoted_fts"]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
    }
  } finally { closeLcmConnection(path); }
  const events = new EventsDb(eventsDbPath(cwd, paths));
  try { expect(events.getUnprocessed()).toEqual([]); } finally { events.close(); }
});

it("unrelated capture and tool events never walk enrolled worker directories", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-lookup-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" });
  const discovery = vi.spyOn(subagentDiscovery, "discoverSubagentTranscripts");
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(workerExcluded(cwd, "ordinary", paths)).toBe(false);
    await new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths).write({
      sessionId: "ordinary", messages: [{ role: "user", content: "ordinary", tokenCount: 1 }],
      transcriptPath: join(cwd, "ordinary.jsonl"),
    });
    recordPostToolEvents({ cwd, session_id: "ordinary", tool_name: "Bash", tool_input: { command: "git status" } }, paths);
    expect(discovery).not.toHaveBeenCalled();
  } finally { discovery.mockRestore(); closeLcmConnection(path); }
});


it.each(["startup", "resume", "compact", "clear"])("never lets wire enrollment purge an existing conversation (%s)", async source => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-canary-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await invokeRoute(createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths), {
    cwd, session_id: "ordinary", messages: [{ role: "user", content: "ORDINARY_RESUME_CANARY", tokenCount: 10 }],
  });
  await expect(invokeRoute(createWorkerSessionHandler(paths), {
    cwd, session_id: "ordinary", client: "claude", owner: "forged-owner", declared: true, source,
  })).rejects.toThrow();
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "ORDINARY_RESUME_CANARY" }]);
    expect(new WorkerStore(db).excluded("ordinary")).toBe(false);
  } finally { closeLcmConnection(path); }
});

it.each(["worker", "excluded-child"])("wire ancestry naming %s refuses capture without deleting a victim's history", async parentSessionId => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-parent-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const ingest = createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths);
  await invokeRoute(ingest, { cwd, session_id: "victim", messages: [
    { role: "user", content: "VICTIM_HISTORY", tokenCount: 100, parts: [{ type: "text", text: "VICTIM_HISTORY" }] },
  ] });
  recordPostToolEvents({ cwd, session_id: "victim", tool_name: "Bash", tool_input: { command: 'git commit -m "VICTIM_HISTORY"' } }, paths);
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    const capture = new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths);
    const stored = await capture.stored("victim");
    await new CompactionEngine(capture.conversationStore, capture.summaryStore,
      { ...compactEngineConfig({ env: {} }), freshTailCount: 0, leafMinFanout: 1 }).compact({
        conversationId: stored!.conversationId, tokenBudget: 100, force: true, summarize: async () => "VICTIM_HISTORY",
      });
    const summary = db.prepare("SELECT summary_id FROM summaries").get() as { summary_id: string };
    new PromotedStore(db).insert({ content: "VICTIM_HISTORY", projectId: projectId(cwd), sourceSummaryId: summary.summary_id });
    await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "owner" });
    if (parentSessionId === "excluded-child") new WorkerStore(db).exclude(parentSessionId);
    const enrollment = db.prepare("SELECT * FROM summarize_workers").all();
    const tables = ["messages", "message_parts", "summaries", "context_items", "messages_fts", "summaries_fts", "promoted", "promoted_fts"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const events = new EventsDb(eventsDbPath(cwd, paths));
    try {
      const oldEvents = events.getUnprocessed();
      expect(oldEvents).toHaveLength(1);
      expect(await invokeRoute(ingest, { cwd, session_id: "victim", parent_session_id: parentSessionId, messages: [
        { role: "user", content: "new capture", tokenCount: 1 },
      ] })).toMatchObject({ ingested: 0 });
      expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(events.getUnprocessed()).toEqual(oldEvents);
      expect(db.prepare("SELECT * FROM summarize_workers").all()).toEqual(enrollment);
      expect(db.prepare("SELECT * FROM session_ingest_log WHERE session_id = 'victim'").get()).toBeUndefined();
      expect(await invokeRoute(ingest, { cwd, session_id: "victim", messages: [
        { role: "user", content: "VICTIM_HISTORY", tokenCount: 100 },
        { role: "user", content: "ordinary later capture", tokenCount: 1 },
      ] })).toMatchObject({ ingested: 1 });
      expect(db.prepare("SELECT content FROM messages WHERE content = 'ordinary later capture'").get()).toBeDefined();
    } finally { events.close(); }
  } finally { closeLcmConnection(path); }
});

it.each(["resume", "compact", "fork", "continue", undefined])("refuses Codex enrollment on a non-new start (%s)", async source => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-start-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  vi.stubEnv("LCM_SUMMARIZE_WORKER", "1");
  try {
    await dispatchCodexHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "ordinary", cwd, source }), {
      workerOwner: () => "owner", paths, enabled: true, client: { post: vi.fn() }, connect: vi.fn(),
    });
    expect((await import("../src/worker-session.js")).workerEnrollments(cwd, paths)).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});

it("ignores forged worker claim metadata in structured ingest", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-wire-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const handler = createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths);
  await invokeRoute(handler, { cwd, session_id: "ordinary", messages: [
    { role: "user", content: "ORDINARY_WIRE_CANARY", tokenCount: 10, workerClaims: ["fake"], workerPayloads: ["fake"] },
  ] });
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "ORDINARY_WIRE_CANARY" }]);
    expect(new WorkerStore(db).excluded("ordinary")).toBe(false);
    expect(db.prepare("SELECT * FROM worker_claim_markers").all()).toEqual([]);
  } finally { closeLcmConnection(path); }
});

it("Claude command resume preserves an ordinary conversation canary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-claude-resume-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await invokeRoute(createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths), {
    cwd, session_id: "ordinary", messages: [{ role: "user", content: "CLAUDE_RESUME_CANARY", tokenCount: 10 }],
  });
  vi.stubEnv("LCM_HOME", paths.home); vi.stubEnv("LCM_SUMMARIZE_WORKER", "1");
  vi.spyOn(await import("../src/hooks/worker-owner.js"), "workerHookOwner").mockReturnValue("native-owner");
  try {
    const { dispatchHook } = await import("../src/hooks/dispatch.js");
    await dispatchHook("restore", JSON.stringify({ cwd, session_id: "ordinary", source: "resume" }));
    const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
    try {
      expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "CLAUDE_RESUME_CANARY" }]);
      expect(new WorkerStore(db).excluded("ordinary")).toBe(false);
    } finally { closeLcmConnection(path); }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it("worker status and stats expose a shortened id instead of the harness session id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-display-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const sessionId = "worker-session-unique-full-identity-685";
  await registerWorkerSession(paths, { sessionId, cwd, client: "claude", owner: "hook" });
  const status = await invokeRoute<{ project: { workers: Array<{ session_id: string }> } }>(
    createStatusHandler(loadDaemonConfig("/nonexistent", {}, {}), paths, Date.now()), { cwd });
  expect(JSON.stringify(status)).not.toContain(sessionId);
  expect(status.project.workers[0].session_id).toHaveLength(8);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    printStats(collectStats(paths), false);
    expect(output.mock.calls.flat().join("\n")).not.toContain(sessionId);
    expect(output.mock.calls.flat().join("\n")).toContain("Worker");
  } finally { output.mockRestore(); }
});

it("a resume cannot reuse live admission left by a worker without SessionEnd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-resume-admission-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "codex", owner: "previous-process" });
  vi.stubEnv("LCM_SUMMARIZE_WORKER", "1");
  try {
    await dispatchCodexHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "worker", cwd, source: "resume" }), {
      workerOwner: () => "new-process", paths, enabled: true, client: { post: vi.fn() }, connect: vi.fn(),
    });
    const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
    try {
      expect(new WorkerStore(db).live("worker", cwd, "codex")).toBe(false);
      expect(new WorkerStore(db).excluded("worker")).toBe(true);
    } finally { closeLcmConnection(path); }
  } finally { vi.unstubAllEnvs(); }
});

it("clear requires a new id and revokes old admission even when replacement enrollment fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-clear-refusal-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const register = createWorkerSessionHandler(paths);
  const input = { cwd, session_id: "old", client: "claude", owner: "native-owner", declared: true };
  await invokeRoute(register, { ...input, source: "startup" });
  await expect(invokeRoute(register, { ...input, source: "clear" })).rejects.toThrow();
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(new WorkerStore(db).live("old", cwd, "claude")).toBe(false);
    expect(new WorkerStore(db).excluded("old")).toBe(true);
  } finally { closeLcmConnection(path); }
});
