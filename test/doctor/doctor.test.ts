import * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";
import { LCM_MD_CONTENT } from "../../src/guidance.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";
import { PKG_VERSION } from "../../src/daemon/version.js";
import { GUIDANCE_CHECK_NAMES } from "../../src/doctor/guidance-checks.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { rememberSubagentGuard, subagentGuardFingerprint } from "../../src/daemon/subagent-guard-failures.js";
import { claudeProjectSlug, projectDir } from "../../src/daemon/project.js";
import { CWD_CHECK_DEADLINE_MS, cleanupStaleProjectStores } from "../../src/doctor/store-hygiene.js";
import { updateProjectMeta } from "../../src/daemon/project-meta.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("../../src/daemon/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/daemon/lifecycle.js")>()),
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

vi.mock("../../src/db/events-stats.js", () => ({
  collectEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 1, total: 1 }),
  collectDetailedEventStats: vi.fn().mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 1, total: 1, projects: [], recentErrors: [], recentHookObservations: [], recentHookFailures: [], hookFailures: 0 }),
}));

import { collectDetailedEventStats, collectEventStats } from "../../src/db/events-stats.js";
const mockCollectEventStats = vi.mocked(collectEventStats);

const INSTALLED_LCM = JSON.stringify({ version: 2, plugins: { "lcm@lossless-claude": [{ scope: "user", version: "0.9.0" }] } });

function buildSettingsJson(): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, command } of REQUIRED_HOOKS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks, mcpServers: { "lcm": {} } });
}

function buildCleanSettingsJson(): string {
  // No hooks in settings.json — hooks are owned by plugin.json, not settings.json.
  // This produces hooks status: "pass" from the doctor.
  return JSON.stringify({ mcpServers: { "lcm": {} } });
}

function minimalDeps(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
  return {
    existsSync: () => true,
    readFileSync: (path: string) => {
      if (path.endsWith("config.json")) return "{}";
      if (path.endsWith("settings.json")) return buildCleanSettingsJson();
      if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
      if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
      if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
      if (path.endsWith("installed_plugins.json")) return INSTALLED_LCM;
      return "{}";
    },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    fetch: vi.fn().mockResolvedValue({ ok: false }),
    homedir: "/tmp/test-home",
    lcmHome: "/tmp/test-home/.lossless-claude",
    platform: "darwin",
    ...overrides,
  };
}

it("doctor finishes a hung cwd check and reports the other checks", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-cwd-deadline-"));
  const paths = createLcmPaths(home);
  const cwd = join(home, "unreachable");
  updateProjectMeta(cwd, paths, { cwd });
  vi.useFakeTimers();
  const stat = vi.mocked(fsPromises.stat);
  stat.mockImplementationOnce(() => new Promise(() => {}));
  try {
    const pending = runDoctor(minimalDeps({ lcmHome: home }));
    await vi.waitFor(() => expect(stat).toHaveBeenCalledWith(cwd));
    await vi.advanceTimersByTimeAsync(CWD_CHECK_DEADLINE_MS);
    const results = await pending;
    expect(stat).toHaveBeenCalledWith(cwd);
    const result = results.find(r => r.name === "stale-project-stores");
    expect(result?.message).toContain("1 project directories with unchecked cwd");
    expect(result?.message).toContain("0 project directories with missing cwd");
    expect(results.find(r => r.name === "orphan-summaries")?.status).toBe("pass");
  } finally {
    stat.mockReset();
    stat.mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).stat);
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});

it("doctor counts missing metadata and all missing working directories without changing stores", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-project-record-doctor-"));
  const paths = createLcmPaths(home);
  const present = join(home, "present");
  mkdirSync(present);
  try {
    const records = [
      { cwd: present },
      { cwd: join(home, "gone") },
      { cwd: "/workspace/lcm-doctor-missing-checkout" },
      {},
    ];
    for (const [i, record] of records.entries()) {
      const dir = join(paths.projectsDir, `record-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify(record));
    }
    const corrupt = join(paths.projectsDir, "corrupt");
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, "meta.json"), "corrupt bytes");
    for (let i = 0; i < 2; i++) mkdirSync(join(paths.projectsDir, `missing-${i}`));
    writeFileSync(join(paths.projectsDir, "ordinary-file"), "not a project directory");
    const before = readdirSync(paths.projectsDir).sort();
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "stale-project-stores");
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("2 project directories without meta.json");
    expect(result?.message).toContain("2 project directories with missing cwd");
    expect(readdirSync(paths.projectsDir).sort()).toEqual(before);
    for (const [i, record] of records.entries()) {
      expect(readFileSync(join(paths.projectsDir, `record-${i}`, "meta.json"), "utf8")).toBe(JSON.stringify(record));
    }
    expect(readFileSync(join(corrupt, "meta.json"), "utf8")).toBe("corrupt bytes");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor counts a missing ordinary checkout without warning about it", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-project-record-doctor-missing-"));
  const paths = createLcmPaths(home);
  try {
    // An ordinary checkout may be on an unmounted disk: it is counted, not treated as stale.
    const dir = join(paths.projectsDir, "a".repeat(64));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: "/workspace/lcm-doctor-unmounted-checkout" }));
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "stale-project-stores");
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("1 project directories with missing cwd");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor reports zero missing project records and working directories in an empty store", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-project-record-doctor-empty-"));
  try {
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "stale-project-stores");
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("0 project directories without meta.json");
    expect(result?.message).toContain("0 project directories with missing cwd");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor reports missing temporary and test project stores without changing them", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-store-doctor-"));
  const paths = createLcmPaths(home);
  const missingTemp = join(home, "lossless-ingest-gone");
  const missingTest = "/workspace/e2e-test-doctor-gone";
  const normal = "/workspace/retained-repository";
  const active = join(home, "e2e-test-active");
  mkdirSync(active);
  try {
    for (const cwd of [missingTemp, missingTest, normal, active]) updateProjectMeta(cwd, paths, { cwd });
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "stale-project-stores");
    expect(result?.status).toBe("warn");
    expect(result?.category).toBe("Storage");
    expect(result?.message).toContain("2 stale project stores");
    expect(result?.message).toContain(missingTemp);
    expect(result?.message).toContain(missingTest);
    expect(result?.message).not.toContain(normal);
    expect(result?.message).not.toContain(active);
    expect(result?.message).toContain("lcm doctor --cleanup-stale-projects --dry-run");
    for (const cwd of [missingTemp, missingTest, normal, active]) expect(existsSync(projectDir(cwd, paths))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor lists a bounded sample of stale stores and only the stores that hold orphans", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-store-doctor-many-"));
  const paths = createLcmPaths(home);
  try {
    const { openStandaloneLcmConnection } = await import("../../src/db/connection.js");
    const { runLcmMigrations } = await import("../../src/db/migration.js");
    const gone = Array.from({ length: 25 }, (_, i) => join(home, `lossless-ingest-gone-${i}`));
    for (const cwd of gone) updateProjectMeta(cwd, paths, { cwd });
    const clean = join(home, "clean-project");
    mkdirSync(clean);
    updateProjectMeta(clean, paths, { cwd: clean });
    const db = openStandaloneLcmConnection(join(projectDir(clean, paths), "db.sqlite"));
    try { runLcmMigrations(db); } finally { db.close(); }
    const results = await runDoctor(minimalDeps({ lcmHome: home }));
    const stale = results.find(r => r.name === "stale-project-stores")?.message ?? "";
    expect(stale).toContain("25 stale project stores");
    expect(stale).toContain("… and 5 more");
    expect(gone.filter(cwd => stale.includes(`${cwd}\n`) || stale.endsWith(cwd))).toHaveLength(20);
    const orphans = results.find(r => r.name === "orphan-summaries");
    expect(orphans?.status).toBe("pass");
    expect(orphans?.message).not.toContain(projectDir(clean, paths));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor aggregates stores without usable project records and leaves the full list in cleanup preview", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-unchecked-"));
  const paths = createLcmPaths(home);
  try {
    const stores = Array.from({ length: 25 }, (_, i) => join(paths.projectsDir, `no-record-${i}`));
    for (const dir of stores) mkdirSync(dir, { recursive: true });
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "stale-project-stores");
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("25 stores not checked (unreadable or invalid project record)");
    expect(result?.message).toContain("lcm doctor --cleanup-stale-projects --dry-run");
    for (const dir of stores) expect(result?.message).not.toContain(dir);
    const preview = cleanupStaleProjectStores(paths);
    for (const dir of stores) expect(preview).toContain(dir);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor bounds orphan stores, summary ids and database errors and exposes full verbose details", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-orphan-lists-"));
  const paths = createLcmPaths(home);
  try {
    const stores = Array.from({ length: 25 }, (_, i) => join(paths.projectsDir, `orphan-store-${i}`));
    const broken = Array.from({ length: 25 }, (_, i) => join(paths.projectsDir, `z-broken-store-${i}`));
    for (const dir of stores) {
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(join(dir, "db.sqlite"));
      try {
        db.exec("CREATE TABLE summaries (summary_id TEXT); CREATE TABLE context_items (summary_id TEXT); CREATE TABLE summary_parents (parent_summary_id TEXT)");
        for (let i = 0; i < 25; i++) db.prepare("INSERT INTO summaries VALUES (?)").run(`orphan-${String(i).padStart(2, "0")}`);
      } finally { db.close(); }
    }
    for (const dir of broken) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "db.sqlite"), "unreadable database");
    }
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "orphan-summaries");
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("625 orphan summaries");
    expect(result?.message).toContain("25 stores not checked");
    expect(result?.message).toContain("… and ");
    expect(result?.message).toContain("lcm doctor --verbose");
    expect((result?.message.match(/: (?:25 orphan summaries|not checked)/g) ?? []).length).toBeLessThanOrEqual(20);
    expect(result?.message).toContain("orphan-19, … and 5 more");
    expect(result?.message).not.toContain("orphan-24");
    const full = (await runDoctor(minimalDeps({ lcmHome: home }), true)).find(r => r.name === "orphan-summaries");
    for (const dir of [...stores, ...broken]) expect(full?.message).toContain(dir);
    expect(full?.message).toContain("orphan-24");
    expect(full?.message).not.toContain("… and ");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor points to verbose orphan details only when something was left out", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-orphan-short-"));
  const paths = createLcmPaths(home);
  try {
    const dir = join(paths.projectsDir, "orphan-store");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "db.sqlite"));
    try {
      db.exec("CREATE TABLE summaries (summary_id TEXT); CREATE TABLE context_items (summary_id TEXT); CREATE TABLE summary_parents (parent_summary_id TEXT)");
      for (const id of ["orphan-a", "orphan-b"]) db.prepare("INSERT INTO summaries VALUES (?)").run(id);
    } finally { db.close(); }
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "orphan-summaries");
    expect(result?.message).toContain("2 orphan summaries (orphan-a, orphan-b)");
    expect(result?.message).not.toContain("lcm doctor --verbose");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor skips orphan lineage queries for empty summaries even without a project record", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-empty-summaries-"));
  const paths = createLcmPaths(home);
  const dir = join(paths.projectsDir, "no-project-record");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  try {
    // Deliberately omit lineage tables: reaching the orphan query would fail.
    db.exec("CREATE TABLE summaries (summary_id TEXT)");
    const empty = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "orphan-summaries");
    expect(empty?.status).toBe("pass");
    expect(empty?.message).toContain("0 orphan summaries");
    db.prepare("INSERT INTO summaries VALUES (?)").run("requires-lineage-check");
    const populated = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "orphan-summaries");
    expect(populated?.status).toBe("warn");
    expect(populated?.message).toContain("unsupported schema");
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

it("doctor bounds backup and capture lists across projects and keeps their full verbose review", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-doctor-project-lists-"));
  const paths = createLcmPaths(home);
  const { runLcmMigrations } = await import("../../src/db/migration.js");
  try {
    const cwds = Array.from({ length: 25 }, (_, i) => join(home, `project-${i}`));
    for (const [i, cwd] of cwds.entries()) {
      mkdirSync(cwd);
      updateProjectMeta(cwd, paths, { cwd });
      const db = new DatabaseSync(join(projectDir(cwd, paths), "db.sqlite"));
      try { runLcmMigrations(db); } finally { db.close(); }
      writeFileSync(join(projectDir(cwd, paths), "db.sqlite.bak-rebuild-fixture"), "backup");
      const transcripts = join(home, ".claude", "projects", claudeProjectSlug(cwd));
      mkdirSync(transcripts, { recursive: true });
      const transcript = join(transcripts, `session-${i}.jsonl`);
      writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "retained" } }) + "\n");
      const old = new Date(Date.now() - 86_400_000);
      utimesSync(transcript, old, old);
      rememberSubagentGuard(cwd, paths, transcript, subagentGuardFingerprint(transcript), `session-${i}`, "parent", "prefix differs");
    }
    const deps = minimalDeps({ lcmHome: home, homedir: home, cwd: home });
    const normal = await runDoctor(deps);
    const full = await runDoctor(deps, true);
    for (const name of ["rebuild-backups", "claude-capture", "claude-subagent-guards"]) {
      const message = normal.find(r => r.name === name)?.message ?? "";
      expect(message).toContain("… and 5 more");
      expect(message).toContain("lcm doctor --verbose");
      const locations = name === "rebuild-backups" ? cwds.map(cwd => projectDir(cwd, paths)) : cwds;
      expect(message.split("\n").filter(line => locations.some(location => line.includes(location)))).toHaveLength(20);
      const review = full.find(r => r.name === name)?.message ?? "";
      for (const location of locations) expect(review).toContain(location);
      expect(review).not.toContain("… and ");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor reports orphan summaries per store without repairing context or dropping summaries", async () => {
  const { openStandaloneLcmConnection } = await import("../../src/db/connection.js");
  const { runLcmMigrations } = await import("../../src/db/migration.js");
  const { ConversationStore } = await import("../../src/store/conversation-store.js");
  const { SummaryStore } = await import("../../src/store/summary-store.js");
  const home = mkdtempSync(join(tmpdir(), "lcm-orphan-doctor-"));
  const paths = createLcmPaths(home);
  const cwd = join(home, "active-project");
  mkdirSync(cwd);
  updateProjectMeta(cwd, paths, { cwd });
  const db = openStandaloneLcmConnection(join(projectDir(cwd, paths), "db.sqlite"));
  try {
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    const conversationId = (await conversations.getOrCreateConversation("orphan-session")).conversationId;
    const messages = await conversations.createMessagesBulk([0, 1].map(seq => ({ conversationId, seq, role: "user" as const, content: "retained", tokenCount: 1 })));
    await summaries.appendContextMessages(conversationId, messages.map(message => message.messageId));
    for (const [summaryId, kind] of [["in-context", "leaf"], ["source", "leaf"], ["root", "condensed"], ["orphan-leaf", "leaf"], ["orphan-condensed", "condensed"]] as const) {
      await summaries.insertSummary({ summaryId, conversationId, kind, content: "private summary text", tokenCount: 1 });
    }
    await summaries.linkSummaryToParents("root", ["source"]);
    await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 0, endOrdinal: 0, summaryId: "in-context" });
    await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 1, endOrdinal: 1, summaryId: "root" });
    const before = await summaries.getContextItems(conversationId);
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(r => r.name === "orphan-summaries");
    expect(result?.status).toBe("warn");
    expect(result?.category).toBe("Storage");
    expect(result?.message).toContain(`${projectDir(cwd, paths)}: 2 orphan summaries`);
    expect(result?.message).toContain("orphan-leaf");
    expect(result?.message).toContain("orphan-condensed");
    expect(result?.message).not.toContain("private summary text");
    expect(result?.fixApplied).not.toBe(true);
    expect(await summaries.getContextItems(conversationId)).toEqual(before);
    for (const id of ["in-context", "source", "root", "orphan-leaf", "orphan-condensed"]) expect(await summaries.getSummary(id)).not.toBeNull();
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

it("doctor reports invalid project records and unsupported summary databases as not checked", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-unchecked-doctor-"));
  const dir = join(createLcmPaths(home).projectsDir, "invalid-record");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "invalid json");
  writeFileSync(join(dir, "db.sqlite"), "unsupported database");
  try {
    const results = await runDoctor(minimalDeps({ lcmHome: home }));
    for (const name of ["stale-project-stores", "orphan-summaries"]) {
      const result = results.find(result => result.name === name);
      expect(result?.status).toBe("warn");
      if (name === "orphan-summaries") expect(result?.message).toContain(dir);
      else expect(result?.message).toContain("1 stores not checked");
      expect(result?.message).toContain("not checked");
      expect(result?.fixApplied).not.toBe(true);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor exposes a shortened worker id", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registerWorkerSession } = await import("../../src/worker-session.js");
  const { createLcmPaths } = await import("../../src/lcm-paths.js");
  const home = mkdtempSync(join(tmpdir(), "lcm-worker-doctor-"));
  const sessionId = "worker-session-unique-full-identity-685";
  try {
    await registerWorkerSession(createLcmPaths(home), { sessionId, cwd: process.cwd(), client: "claude", owner: "hook" });
    const results = await runDoctor(minimalDeps({ lcmHome: home }));
    const workers = results.filter(result => result.name.startsWith("summarize-worker-"));
    expect(workers).toHaveLength(1);
    expect(JSON.stringify(workers)).not.toContain(sessionId);
    expect(workers[0].name).toMatch(/^summarize-worker-[a-f0-9]{8}$/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("doctor identifies copied-claim recovery with a short id and cwd for reviewing retained history", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createLcmPaths } = await import("../../src/lcm-paths.js");
  const { projectDbPath, projectId } = await import("../../src/daemon/project.js");
  const { openProject } = await import("../../src/daemon/project-group.js");
  const { getLcmConnection, closeLcmConnection } = await import("../../src/db/connection.js");
  const { runLcmMigrations } = await import("../../src/db/migration.js");
  const { SessionCapture } = await import("../../src/capture.js");
  const { ScrubEngine } = await import("../../src/scrub.js");
  const { parseClaudeTranscriptRecord } = await import("../../src/transcript.js");
  const { WorkerStore } = await import("../../src/store/worker-store.js");
  const home = mkdtempSync(join(tmpdir(), "lcm-claim-doctor-"));
  const cwd = process.cwd(); const paths = createLcmPaths(home);
  const sessionId = "copied-claim-full-session-id-685";
  const path = projectDbPath(cwd, paths);
  try {
    openProject(cwd, paths);
    const db = getLcmConnection(path);
    try {
      runLcmMigrations(db);
      const capture = new SessionCapture(db, projectId(cwd), new ScrubEngine([], []), paths);
      await capture.write({ sessionId, cwd, messages: [{ role: "user", content: "retained history", tokenCount: 1 }] });
      new WorkerStore(db).recordIssuedJob("job-issued");
      await capture.write({ sessionId, cwd, messages: [
        { message: { role: "assistant", content: [{ type: "tool_use", id: "claim", name: "lcm_summarize_claim", input: {} }] } },
        { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claim", content: JSON.stringify({ job: { id: "job-issued", prompt: "payload", system: "system" } }) }] } },
      ].map(record => parseClaudeTranscriptRecord(JSON.stringify(record)).message!) });
      expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "retained history" }]);
    } finally { closeLcmConnection(path); }
    const result = (await runDoctor(minimalDeps({ lcmHome: home }))).find(result => result.name.startsWith("summarize-worker-"))!;
    expect(result.name).toMatch(/^summarize-worker-[a-f0-9]{8}$/);
    expect(JSON.stringify(result)).not.toContain(sessionId);
    expect(result.message).toContain(cwd);
    expect(result.message).toContain("Copied successful claim");
    expect(result.message).toContain("stored history is preserved");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe("runDoctor security section", () => {
  it("shows gitleaks + native pattern counts as pass when generated-patterns.ts exists", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const detection = results.find((r) => r.name === "secret-detection");
    expect(detection?.status).toBe("pass");
    expect(detection?.message).toContain("gitleaks");
    expect(detection?.message).toContain("native");
    expect(detection?.category).toBe("Security");
  });

  it("shows user pattern counts (no warning when zero project patterns)", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const userPatterns = results.find((r) => r.name === "user-patterns");
    // No warning for zero patterns — just informational
    expect(userPatterns?.status).toBe("pass");
    expect(userPatterns?.category).toBe("Security");
  });
});

describe("runDoctor capture section", () => {
  it("reports whether Claude Code transcripts hold sessions with nothing stored", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const capture = results.find((r) => r.name === "claude-capture");
    expect(capture?.category).toBe("Capture");
    expect(capture?.status).toBe("pass");
  });
});

describe("runDoctor guidance checks", () => {
  it("runs the check for every guidance row when every harness CLI is on PATH", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const names = new Set(results.map((r) => r.name));
    for (const name of Object.values(GUIDANCE_CHECK_NAMES)) expect(names).toContain(name);
  });
});

describe("runDoctor lcm-md check", () => {
  it("passes when lcm.md exists and CLAUDE.md has managed block", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/nonexistent-project-xyz" }));
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("lcm.md");
  });

  it("auto-restores and reports fixApplied when lcm.md is missing", async () => {
    const written: Record<string, string> = {};
    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      existsSync: (p: string) => !p.endsWith("lcm.md"),
      writeFileSync: vi.fn((p: string, c: string) => { written[p] = c; }),
    });
    const results = await runDoctor(deps);
    const check = results.find((r) => r.name === "lcm-md");
    expect(check?.status).toBe("warn");
    expect(check?.fixApplied).toBe(true);
    expect(written["/tmp/test-home/.claude/lcm.md"]).toBeDefined();
  });
});

describe("runDoctor daemon version mismatch", () => {
  it("auto-restarts daemon on version mismatch and reports fixApplied when post-restart version matches", async () => {
    const pkgVersion = PKG_VERSION!;
    const daemonVersion = "0.0.1";

    // ensureDaemon returns connected on restart attempt
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        if (path.endsWith("installed_plugins.json")) return INSTALLED_LCM;
      return "{}";
      },
      // First fetch: daemon up with old version; second fetch: post-restart with new version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: pkgVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(vi.mocked(ensureDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: pkgVersion }),
    );
    expect(daemonResult?.fixApplied).toBe(true);
    expect(daemonResult?.message).toContain("restarted");
    expect(daemonResult?.message).toContain(daemonVersion);
    expect(daemonResult?.message).toContain(pkgVersion);
  });

  it("reports warn with fixApplied:false when restart does not fix version mismatch", async () => {
    const pkgVersion = PKG_VERSION!;
    const daemonVersion = "0.0.1";

    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: true, port: 7865, spawned: true });

    const deps = minimalDeps({
      cwd: "/tmp/nonexistent-project-xyz",
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: pkgVersion });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        if (path.endsWith("installed_plugins.json")) return INSTALLED_LCM;
      return "{}";
      },
      // Post-restart health still returns old version
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: daemonVersion }) }),
    });

    const results = await runDoctor(deps);
    const daemonResult = results.find((r) => r.name === "daemon");

    expect(daemonResult?.fixApplied).toBe(false);
    expect(daemonResult?.status).toBe("warn");
    expect(daemonResult?.message).toContain("did not fix it");
  });
});

describe("runDoctor summarizer modes", () => {
  it("reports auto mode as Claude and Codex process defaults", async () => {
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (path: string) => {
        if (path.endsWith("config.json")) return JSON.stringify({ llm: { provider: "auto" } });
        if (path.endsWith("settings.json")) return buildSettingsJson();
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("installed_plugins.json")) return INSTALLED_LCM;
      return "{}";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1]?.includes("command -v claude")) {
          return { status: 0, stdout: "/usr/bin/claude", stderr: "" };
        }
        if (cmd === "sh" && args[1]?.includes("command -v codex")) {
          return { status: 0, stdout: "/usr/bin/codex", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
    lcmHome: "/tmp/test-home/.lossless-claude",
      platform: "darwin",
    });

    expect(results.find((result) => result.name === "stack")?.message).toContain("Summarizer: auto");
    expect(results.some((result) => result.name === "claude-process")).toBe(true);
    expect(results.some((result) => result.name === "codex-process")).toBe(true);
    expect(results.some((result) => result.name === "copilot-process")).toBe(true);
    expect(results.some((result) => result.name === "omp-process")).toBe(true);
  });
});

describe("Passive Learning checks", () => {
  it("reports unknown hook coverage when verbose inspection finds no retained evidence", async () => {
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/lcm-no-hook-evidence-project" }), true);
    expect(results.find((result) => result.name === "hook-coverage")).toMatchObject({
      status: "warn", message: expect.stringContaining("coverage unknown"),
    });
  });

  it("shows Codex hook outcomes in verbose mode without the Claude plugin", async () => {
    vi.mocked(collectDetailedEventStats).mockReturnValueOnce({
      captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 1, total: 1,
      projects: [], recentErrors: [], recentHookFailures: [], hookFailures: 0,
      recentHookObservations: [{ file: "codex.db", sessionId: "codex-session", harness: "codex",
        hook: "PreCompact", operation: "capture", kind: "execution", status: "completed",
        reason: "", count: 1, lastSeen: "2026-09-27 12:00:00" }],
    });
    const base = minimalDeps({ cwd: "/tmp/test-proj" });
    const results = await runDoctor({ ...base,
      readFileSync: (path: string) => path.endsWith("installed_plugins.json")
        ? "{}" : base.readFileSync(path),
    }, true);
    expect(results.find((r) => r.name === "hooks")?.status).toBe("fail");
    expect(results.find((r) => r.name === "hook-outcomes")?.message).toContain("codex/PreCompact");
  });

  it("runs passive learning checks when hooks status is warn (auto-fixed duplicates)", async () => {
    // Use deps where hooks check produces "warn" (duplicate hooks in settings.json auto-fixed)
    mockCollectEventStats.mockReturnValue({ captured: 10, unprocessed: 0, errors: 0, lastCapture: null, scanned: 1, total: 1 });
    const depsWithBadHooks = minimalDeps({
      readFileSync: (path: string) => {
        if (path.endsWith("settings.json")) return buildSettingsJson(); // duplicate hooks → produces warn
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        if (path.endsWith("installed_plugins.json")) return INSTALLED_LCM;
      return "{}";
      },
    });
    const results = await runDoctor(depsWithBadHooks);
    const plResults = results.filter(r => r.category === "Passive Learning");
    // "warn" status should allow passive learning checks to run
    expect(plResults.length).toBeGreaterThan(0);
  });

  it("warns when hooks installed but no events captured", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 1, total: 1 });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("No events captured");
  });

  it("passes when events exist and unprocessed is low", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00", scanned: 1, total: 1 });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("pass");
  });

  it("warns when unprocessed > 1000", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 5000, unprocessed: 2000, errors: 0, lastCapture: "2026-03-26 10:00:00", scanned: 1, total: 1 });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("unprocessed");
  });

  it("fails when errors >= 50", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 50, lastCapture: "2026-03-26 10:00:00", scanned: 1, total: 1 });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("fail");
  });

  it("passes errors when 0 errors", async () => {
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: "2026-03-26 10:00:00", scanned: 1, total: 1 });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("pass");
  });

  it("passes staleness when last capture is recent", async () => {
    const now = new Date();
    const recentCapture = now.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: recentCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("pass");
  });

  it("warns staleness when last capture >= 7 days", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldCapture = old.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    mockCollectEventStats.mockReturnValue({ captured: 100, unprocessed: 5, errors: 0, lastCapture: oldCapture });
    const results = await runDoctor(minimalDeps({ cwd: "/tmp/test-proj" }));
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("warn");
    expect(staleness?.message).toContain("hooks may not be firing");
  });
});

describe("runDoctor plugin bundle", () => {
  const registry = (installPath: string) =>
    JSON.stringify({ version: 2, plugins: { "lcm@lossless-claude": [{ scope: "user", version: "0.13.0", installPath }] } });
  const bundleManifest = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bundle/lcm.js", "restore"] }] }] } });
  const launcherManifest = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" restore" }] }] } });

  function depsWith(manifest: string, bundlePresent: boolean) {
    const installPath = "/tmp/test-home/.claude/plugins/cache/lossless-claude/lcm/0.13.0";
    return minimalDeps({
      existsSync: (path: string) => path.endsWith("bundle/lcm.js") ? bundlePresent : true,
      readFileSync: (path: string) => {
        if (path.endsWith("installed_plugins.json")) return registry(installPath);
        if (path.endsWith(".claude-plugin/plugin.json")) return manifest;
        if (path.endsWith("config.json")) return "{}";
        if (path.endsWith("settings.json")) return buildCleanSettingsJson();
        if (path.endsWith("CLAUDE.md")) return "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
        if (path.endsWith("lcm.md")) return LCM_MD_CONTENT;
        return "{}";
      },
    });
  }

  it("fails when the installed manifest calls bundle/lcm.js and the bundle is missing", async () => {
    const result = (await runDoctor(depsWith(bundleManifest, false))).find((r) => r.name === "plugin-bundle");
    expect(result?.status).toBe("fail");
    expect(result?.message).toContain("claude plugin update lcm@lossless-claude");
  });

  it("passes when the bundle is present", async () => {
    const result = (await runDoctor(depsWith(bundleManifest, true))).find((r) => r.name === "plugin-bundle");
    expect(result?.status).toBe("pass");
  });

  it("fails when the registered plugin directory has no readable manifest", async () => {
    const deps = depsWith(bundleManifest, true);
    const readFileSync = deps.readFileSync;
    deps.readFileSync = (path: string, enc: string) => {
      if (path.endsWith(".claude-plugin/plugin.json")) throw new Error("ENOENT");
      return readFileSync(path, enc);
    };
    const result = (await runDoctor(deps)).find((r) => r.name === "plugin-bundle");
    expect(result?.status).toBe("fail");
    expect(result?.message).toContain("unreadable");
  });

  it("does not hold a launcher-era plugin to the bundle", async () => {
    const results = await runDoctor(depsWith(launcherManifest, false));
    expect(results.find((r) => r.name === "plugin-bundle")).toBeUndefined();
  });
});

describe("runDoctor summarizer endpoints", () => {
  const namedConfig = JSON.stringify({ llm: { provider: "deepseek", fallback: ["openrouter"], providers: {
    deepseek: { type: "openai", model: "m", apiKey: "${DEEPSEEK_API_KEY}" },
    openrouter: { type: "openai", model: "m", apiKey: "${OPENROUTER_API_KEY}" },
  } } });
  const base = minimalDeps();
  const withEnv = (env: Record<string, string>, overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) => minimalDeps({
    env,
    readFileSync: (path: string) => path.endsWith("config.json") ? namedConfig : base.readFileSync(path),
    ...overrides,
  });
  const endpointChecks = (results: Awaited<ReturnType<typeof runDoctor>>) =>
    results.filter((r) => r.name.startsWith("summarizer-"));

  it("warns for each endpoint left without its variable, and passes the chain while one remains", async () => {
    const checks = endpointChecks(await runDoctor(withEnv({ OPENROUTER_API_KEY: "sk" })));
    expect(checks).toEqual([
      expect.objectContaining({ name: "summarizer-endpoint-deepseek", category: "Summarizer", status: "warn",
        message: expect.stringMatching(/deepseek.*DEEPSEEK_API_KEY/) }),
    ]);
  });

  it("fails when the primary and every fallback are unavailable", async () => {
    const checks = endpointChecks(await runDoctor(withEnv({})));
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["summarizer-endpoint-deepseek", "warn"],
      ["summarizer-endpoint-openrouter", "warn"],
      ["summarizer-chain", "fail"],
    ]);
  });

  it("reports the running daemon's view, since the daemon's environment is the one that summarizes", async () => {
    const health = { status: "ok", version: PKG_VERSION, summarizer: { chain: ["deepseek", "openrouter"],
      unavailable: [{ name: "openrouter", missingEnv: ["OPENROUTER_API_KEY"] }], allUnavailable: false } };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => health });
    const checks = endpointChecks(await runDoctor(withEnv({ DEEPSEEK_API_KEY: "a", OPENROUTER_API_KEY: "b" }, { fetch })));
    expect(checks).toEqual([
      expect.objectContaining({ name: "summarizer-endpoint-openrouter", status: "warn", message: expect.stringContaining("daemon") }),
    ]);
  });
});

describe("runDoctor named process endpoints", () => {
  const namedConfig = JSON.stringify({ llm: { provider: "haiku", fallback: ["cx", "remote"], providers: {
    haiku: { type: "claude-process" },
    cx: { type: "codex-process", model: "m" },
    remote: { type: "openai", model: "m", baseURL: "http://127.0.0.1:9/v1" },
    unused: { type: "copilot-process" },
  } } });
  const base = minimalDeps();

  it("checks the CLI of every process endpoint in the chain, and only those", async () => {
    const results = await runDoctor(minimalDeps({
      readFileSync: (path: string) => path.endsWith("config.json") ? namedConfig : base.readFileSync(path),
      // No CLI is installed: `which` fails for each.
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
    }));
    const processChecks = results.filter((r) => r.name.endsWith("-process"));
    expect(processChecks.map((r) => [r.name, r.category, r.status])).toEqual([
      ["claude-process", "Summarizer", "fail"],
      ["codex-process", "Summarizer", "fail"],
    ]);
  });
});

describe("runDoctor process checks follow the effective chain", () => {
  const configWith = (llm: unknown) => JSON.stringify({ llm });
  const base = minimalDeps();
  const processChecksFor = async (llm: unknown, env: Record<string, string> = {}) => {
    const results = await runDoctor(minimalDeps({
      env,
      readFileSync: (path: string) => path.endsWith("config.json") ? configWith(llm) : base.readFileSync(path),
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
    }));
    return results.filter((r) => r.name.endsWith("-process")).map((r) => r.name);
  };
  const endpoints = {
    remote: { type: "openai", model: "m", baseURL: "http://127.0.0.1:9/v1" },
    cx: { type: "codex-process", model: "m" },
  };

  it("checks the endpoint llm.provider selects by its type", async () => {
    expect(await processChecksFor({ provider: "codex-process", providers: endpoints })).toEqual(["codex-process"]);
  });

  it("checks the endpoint LCM_SUMMARY_PROVIDER promotes by name", async () => {
    expect(await processChecksFor({ provider: "remote", providers: endpoints }, { LCM_SUMMARY_PROVIDER: "cx" })).toEqual(["codex-process"]);
  });

  it("checks the endpoint LCM_SUMMARY_PROVIDER selects by its type", async () => {
    expect(await processChecksFor({ provider: "remote", providers: endpoints }, { LCM_SUMMARY_PROVIDER: "codex-process" }))
      .toEqual(["codex-process"]);
  });
});

describe("runDoctor with a daemon reporting its own chain", () => {
  const base = minimalDeps();
  const llm = { provider: "remote", providers: {
    remote: { type: "openai", model: "m", baseURL: "http://127.0.0.1:9/v1" },
    cx: { type: "codex-process", model: "m" },
  } };
  const deps = (summarizer: unknown) => minimalDeps({
    env: {},
    readFileSync: (path: string) => path.endsWith("config.json") ? JSON.stringify({ llm }) : base.readFileSync(path),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok", version: PKG_VERSION, summarizer }) }),
  });

  it("checks the CLIs of the chain the daemon runs, not the one this shell would", async () => {
    // LCM_SUMMARY_PROVIDER=cx in the daemon's environment only.
    const results = await runDoctor(deps({ chain: ["cx"], unavailable: [], allUnavailable: false }));
    expect(results.filter((r) => r.name.endsWith("-process")).map((r) => r.name)).toEqual(["codex-process"]);
  });

  it("does not crash on a /health payload of another shape", async () => {
    const results = await runDoctor(deps({ chain: ["remote"], unavailable: [{ name: "remote" }], allUnavailable: false }));
    expect(results.some((r) => r.name === "stack")).toBe(true);
  });
});
