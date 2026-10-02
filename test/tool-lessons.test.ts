import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { readInsights } from "../src/daemon/restore/insights.js";
import type { DaemonConfig } from "../src/daemon/config.js";
import { commandShape, maskBlockReason, ToolLessonStore } from "../src/promotion/tool-lessons.js";

it("forms command shapes with sorted flags and placeholders for paths and values", () => {
  expect(commandShape('git diff --output="/tmp/a.patch" --stat src/a.ts'))
    .toBe("git diff --output --stat <args>");
  expect(commandShape('git diff src/b.ts --stat --output /tmp/b.patch'))
    .toBe("git diff --output --stat <args>");
  expect(commandShape("npm install widget --registry=https://example.test --save"))
    .toBe("npm install --registry --save <args>");
});

it.each([
  ["mysql -psecret -uadmin", "mysql -p -u <args>"],
  ["mysql -psecret", "mysql -p <args>"],
  ['["mysql","-uadmin"]', "mysql -u <args>"],
  ["rm -rf /tmp/cache", "rm -rf <args>"],
  ["mysql -rf", "mysql -r <args>"],
  ["rm -rfsecret", "rm -r <args>"],
  ["mysql -psecret=value", "mysql -p <args>"],
])("keeps only known value-free short clusters in %s", (command, shape) => {
  expect(commandShape(command)).toBe(shape);
});

let db: DatabaseSync, lessons: ToolLessonStore, callOrdinal: number;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  lessons = new ToolLessonStore(db);
  callOrdinal = 0;
});
afterEach(() => db.close());

function storedCall(session: string, command: string, outcome: string, options: {
  name?: string; reason?: string; at?: string; truncated?: number;
} = {}) {
  db.prepare("INSERT INTO conversations (session_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE session_id = ?)")
    .run(session, session);
  const conversation = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(session)!;
  const message = db.prepare("INSERT INTO messages (conversation_id, seq, role, content, token_count, event_at) VALUES (?, ?, 'tool', 'fixture', 1, ?)")
    .run(conversation.conversation_id, ++callOrdinal, options.at ?? "2026-01-01T00:00:00Z");
  const call = db.prepare("INSERT INTO transcript_tool_calls (session_id, call_id, message_id, name, input, outcome, block_reason, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(session, String(callOrdinal), message.lastInsertRowid, options.name ?? "Bash", command, outcome, options.reason ?? null, options.truncated ?? 0);
  return Number(call.lastInsertRowid);
}

function rebuiltSnapshot() {
  const rebuilt = new DatabaseSync(":memory:");
  runLcmMigrations(rebuilt);
  for (const table of ["conversations", "messages", "transcript_tool_calls"]) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const columns = Object.keys(row);
      rebuilt.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...Object.values(row));
    }
  }
  return { db: rebuilt, store: new ToolLessonStore(rebuilt) };
}

it("matches a full rebuild through adds, resolutions, corrections and removals", async () => {
  const first = storedCall("one", "npm install old", "unknown");
  storedCall("one", "npm install new", "succeeded", { at: "2026-01-03T00:00:00Z" });
  const blocked = storedCall("two", "git status", "blocked", { reason: "Blocked: /tmp/a" });
  storedCall("three", "git status", "failed");
  const fourth = storedCall("four", "git status", "failed");
  const assertRebuild = async () => {
    const fresh = rebuiltSnapshot();
    try {
      const expectedPairs = await fresh.store.refresh("project");
      const actualPairs = await lessons.refresh("project");
      expect(actualPairs).toBe(expectedPairs);
      expect(lessons.list({ includeRetired: true })).toEqual(fresh.store.list({ includeRetired: true }));
    } finally { fresh.db.close(); }
  };
  await assertRebuild();
  db.prepare("UPDATE transcript_tool_calls SET outcome = 'failed' WHERE rowid = ?").run(first);
  await assertRebuild();
  db.prepare("UPDATE transcript_tool_calls SET block_reason = 'Blocked: permission' WHERE rowid = ?").run(blocked);
  await assertRebuild();
  storedCall("one", "Read", "unknown", { name: "Read" });
  await assertRebuild();
  storedCall("success", "git status", "succeeded", { at: "2026-01-05T00:00:00Z" });
  await assertRebuild();
  db.prepare("DELETE FROM transcript_tool_calls WHERE rowid = ?").run(fourth);
  await assertRebuild();
  db.prepare("DELETE FROM transcript_tool_calls WHERE session_id = 'success'").run();
  await assertRebuild();
});

it("bounds refresh work by changed calls and their pair windows", async () => {
  for (let index = 0; index < 400; index++) {
    storedCall("large-session", "git status", "blocked", { reason: "Blocked: permission" });
    storedCall("unrelated-" + index, `fixturetool${index} old`, "failed");
    storedCall("unrelated-" + index, `fixturetool${index} new`, "succeeded");
  }
  await lessons.refresh("project");
  const prepare = db.prepare.bind(db);
  let callsRead = 0, lessonsWritten = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT/i.test(sql) && /FROM transcript_tool_calls/i.test(sql)) {
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      statement.all = (...args) => { const rows = all(...args); callsRead += rows.length; return rows; };
      statement.get = (...args) => { const row = get(...args); if (row) callsRead++; return row; };
    }
    if (/INSERT.*INTO tool_lessons/i.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { lessonsWritten++; return run(...args); };
    }
    return statement;
  });
  try {
    storedCall("large-session", "git status", "blocked", { reason: "Blocked: permission" });
    await new ToolLessonStore(db).refresh("project");
    expect(callsRead).toBeLessThanOrEqual(1 + 20 + 20 * 20);
    expect(lessonsWritten).toBeLessThanOrEqual(2);
    callsRead = 0;
    await new ToolLessonStore(db).refresh("project");
    expect(callsRead).toBe(0);
  } finally { spy.mockRestore(); }
});

it("re-derives only the removed call's session, including a newly shortened pair window", async () => {
  storedCall("affected", "npm install old", "failed");
  const removed = storedCall("affected", "Read", "unknown", { name: "Read" });
  for (let index = 0; index < 19; index++) storedCall("affected", "Read", "unknown", { name: "Read" });
  storedCall("affected", "npm install new", "succeeded");
  for (let index = 0; index < 100; index++) storedCall("unrelated", "git status", "failed");
  await lessons.refresh("project");
  expect(lessons.list({ kind: "error-fix" })).toEqual([]);
  db.prepare("DELETE FROM transcript_tool_calls WHERE rowid = ?").run(removed);
  const prepare = db.prepare.bind(db);
  const readSessions = new Set<string>();
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT/i.test(sql) && /FROM transcript_tool_calls/i.test(sql)) {
      const all = statement.all.bind(statement), get = statement.get.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        for (const row of rows) if (typeof row.session_id === "string") readSessions.add(row.session_id);
        return rows;
      };
      statement.get = (...args) => {
        const row = get(...args);
        if (typeof row?.session_id === "string") readSessions.add(row.session_id);
        return row;
      };
    }
    return statement;
  });
  try {
    await new ToolLessonStore(db).refresh("project");
    expect(readSessions).toEqual(new Set(["affected"]));
    expect(lessons.list({ kind: "error-fix" })).toEqual([expect.objectContaining({ count: 1 })]);
  } finally { spy.mockRestore(); }
});

it("resumes interrupted publication without exposing partial lesson updates", async () => {
  storedCall("one", "git status", "blocked", { reason: "Blocked: /tmp/a" });
  await lessons.refresh("project");
  const published = lessons.list({ includeRetired: true });
  storedCall("two", "git status", "blocked", { reason: "Blocked: /tmp/b" });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/INSERT OR REPLACE INTO tool_lessons/.test(sql)) {
      statement.run = () => { throw new Error("publication interrupted"); };
    }
    return statement;
  });
  try {
    await expect(lessons.refresh("project")).rejects.toThrow("publication interrupted");
    expect(lessons.list({ includeRetired: true })).toEqual(published);
  } finally { spy.mockRestore(); }
  await new ToolLessonStore(db).refresh("project");
  expect(lessons.list({ kind: "block-reason" })).toEqual([expect.objectContaining({ count: 2, sessionCounts: { one: 1, two: 1 } })]);
});

it("recomputes retirement after a timestamp repair and worker exclusion", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "git status", "failed", { at: "2026-01-02T00:00:00Z" });
  const success = storedCall("success", "git status", "succeeded", { at: "2026-01-03T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([]);
  db.prepare("UPDATE messages SET event_at = '2026-01-01T00:00:00Z' WHERE message_id = (SELECT message_id FROM transcript_tool_calls WHERE rowid = ?)").run(success);
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ retired: false })]);
  db.prepare("INSERT INTO summarize_workers (session_id, cwd, client, state) VALUES ('three', '/project', 'claude', 'active')").run();
  await lessons.refresh("project");
  expect(lessons.list({ includeRetired: true })).toEqual([]);
});

it("rebuilds an older snapshot once and removes shapes with attached values", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "mysql -psecret", "failed");
  await lessons.refresh("project");
  const legacy = { ...lessons.list()[0], shape: "mysql -psecret" };
  db.prepare("UPDATE tool_lessons SET lesson_key = ?, data = ?").run(JSON.stringify(["environment-rule", legacy.shape]), JSON.stringify(legacy));
  const artifacts = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'tool_lesson_%' AND name <> 'tool_lesson_state' ORDER BY type DESC").all();
  for (const artifact of artifacts) {
    if (artifact.type === "trigger" || artifact.type === "table") db.exec(`DROP ${String(artifact.type)} ${String(artifact.name)}`);
  }
  runLcmMigrations(db);
  await new ToolLessonStore(db).refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ shape: "mysql -p <args>", count: 3 })]);
  runLcmMigrations(db);
  expect(await lessons.refresh("project")).toBe(0);
});

it("derives project-scoped error→fix pairs from succeeded shell calls of the same shape", async () => {
  storedCall("session", "npm install old-package", "failed");
  storedCall("session", "npm install new-package", "succeeded", { at: "2026-01-02T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({
    kind: "error-fix", shape: "npm install <args>", failedCommand: "npm install old-package",
    succeededCommand: "npm install new-package", count: 1, sessionCounts: { session: 1 },
    firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-02T00:00:00.000Z",
    tags: ["type:solution", "source:tool-calls", "project:project"],
  })]);
  expect(lessons.list()[0]).not.toHaveProperty("confidence");
});

it("masks the first line of block reasons and counts occurrences per project and session", async () => {
  storedCall("one", "npm install", "blocked", {
    reason: "PreToolUse:Bash hook error: refused /tmp/cache/a id=abc-123\nignored second line",
    at: "2026-01-01T00:00:00Z",
  });
  storedCall("one", "npm install", "blocked", {
    reason: "PreToolUse:Bash hook error: refused /tmp/cache/b id=def-456",
    at: "2026-01-02T00:00:00Z",
  });
  storedCall("two", "git status", "blocked", {
    reason: "PreToolUse:Bash hook error: refused /var/build/c id=ghi-789",
    at: "2026-01-03T00:00:00Z",
  });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({
    kind: "block-reason", reason: "PreToolUse:Bash hook error: refused <path> id=<id>",
    count: 3, sessionCounts: { one: 2, two: 1 },
    firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-03T00:00:00.000Z",
    tags: ["type:gotcha", "source:tool-calls", "project:project"],
  })]);
});

it("forms an environment rule only after failures in three distinct sessions", async () => {
  for (let occurrence = 0; occurrence < 4; occurrence++) storedCall("one", "npm install widget", "failed");
  storedCall("two", "npm install other", "blocked");
  await lessons.refresh("project");
  expect(lessons.list().filter(lesson => lesson.kind === "environment-rule")).toEqual([]);
  storedCall("three", "npm install last", "failed", { at: "2026-01-03T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({
    kind: "environment-rule", shape: "npm install <args>", count: 6,
    sessionCounts: { one: 4, two: 1, three: 1 }, retired: false,
    tags: ["type:environment", "source:tool-calls", "project:project"],
  })]);
});

it("retires an environment rule on later success, while unknown is no evidence", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "npm install widget", "failed");
  await lessons.refresh("project");
  expect(lessons.list()).toHaveLength(1);
  storedCall("four", "npm install widget", "unknown", { at: "2026-01-02T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toHaveLength(1);
  storedCall("four", "npm install other", "succeeded", { at: "2026-01-03T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([]);
  expect(lessons.list({ includeRetired: true })).toEqual([expect.objectContaining({
    kind: "environment-rule", retired: true, count: 3, lastSeen: "2026-01-03T00:00:00.000Z",
  })]);
});

it.each([19, 20])("bounds error→fix pairs by all calls in the session (%s intervening calls)", async intervening => {
  storedCall("session", "npm install old", "blocked");
  for (let index = 0; index < intervening; index++) storedCall("session", "Read", "unknown", { name: "Read" });
  storedCall("session", "npm install new", "succeeded");
  await lessons.refresh("project");
  expect(lessons.list().filter(lesson => lesson.kind === "error-fix")).toHaveLength(intervening === 19 ? 1 : 0);
});


it("restores only environment rules, as short shape lines without commands or confidence", async () => {
  const now = new Date().toISOString();
  storedCall("session", "npm install old", "failed", { at: now });
  storedCall("session", "npm install new", "succeeded", { at: now });
  for (const session of ["one", "two", "three"]) storedCall(session, "make deploy --target secret-host", "failed", { at: now });
  await lessons.refresh("project");
  expect(lessons.list().map(lesson => lesson.kind).sort()).toEqual(["environment-rule", "error-fix"]);
  const config = { compaction: { promotionThresholds: {} } } as DaemonConfig;
  const insights = readInsights(db, config);
  expect(insights).toHaveLength(1);
  expect(insights[0]).toMatchObject({ count: 3, sessionCount: 3, firstSeen: expect.any(String), lastSeen: expect.any(String) });
  expect(insights[0].content).toContain("`make --target <args>`");
  expect(insights[0].content).not.toContain("secret-host");
  expect(insights[0].content).not.toContain("npm install");
  expect(insights[0]).not.toHaveProperty("confidence");
});

it("restores at most three environment rules", async () => {
  const now = new Date().toISOString();
  for (const tool of ["alpha", "beta", "gamma", "delta"]) {
    for (const session of ["one", "two", "three"]) storedCall(session, `${tool} run`, "failed", { at: now });
  }
  await lessons.refresh("project");
  const insights = readInsights(db, { compaction: { promotionThresholds: {} } } as DaemonConfig);
  expect(insights.filter(insight => insight.content.startsWith("Environment rule"))).toHaveLength(3);
});

it("skips a refresh when no call was added, removed or resolved since the last one", async () => {
  storedCall("session", "npm install old", "failed");
  await lessons.refresh("project");
  const generation = () => (db.prepare("SELECT generation FROM tool_lesson_state").get() as { generation: number }).generation;
  const published = generation();
  await lessons.refresh("project");
  expect(generation()).toBe(published);
  db.prepare("UPDATE transcript_tool_calls SET outcome = 'unknown'").run();
  await lessons.refresh("project");
  expect(generation()).toBeGreaterThan(published);
});

it("yields during refresh and publishes a complete snapshot after an empty one", async () => {
  await lessons.refresh("project");
  const pairCount = 130;
  for (let index = 0; index < pairCount; index++) {
    storedCall("session-" + index, "npm install old-" + index, "failed");
    storedCall("session-" + index, "npm install new-" + index, "succeeded");
  }
  const observedCounts: number[] = [];
  let finished = false;
  const monitor = () => {
    if (finished) return;
    observedCounts.push(lessons.list().length);
    if (!finished) setImmediate(monitor);
  };
  setImmediate(monitor);
  try { await lessons.refresh("project"); } finally { finished = true; }
  expect(observedCounts.length).toBeGreaterThan(0);
  expect(observedCounts.every(count => count === 0 || count === pairCount)).toBe(true);
  expect(lessons.list()).toHaveLength(pairCount);
  const before = lessons.list();
  await lessons.refresh("project");
  expect(lessons.list()).toEqual(before);
});

it.each([
  ["npm install", "unknown"],
  ["npm install", "denied"],
  ["npm install", "interrupted"],
  ["npm test", "succeeded"],
])("does not infer a fix from %s with outcome %s", async (command, outcome) => {
  storedCall("session", "npm install", "failed");
  storedCall("session", command, outcome);
  storedCall("another-session", "npm install", "succeeded");
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([]);
});

it("keeps a rule when success predates its first failure, regardless of session traversal order", async () => {
  storedCall("z-success", "npm install", "succeeded", { at: "2026-01-01T00:00:00Z" });
  for (const session of ["a", "b", "c"]) storedCall(session, "npm install", "failed", { at: "2026-01-02T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ kind: "environment-rule", retired: false })]);
  storedCall("z-success", "npm install", "succeeded", { at: "2026-01-03T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([]);
});

it("counts a block reason even when a truncated command cannot establish a shape", async () => {
  storedCall("session", "npm install [truncated]", "blocked", { truncated: 1, reason: "Blocked: /tmp/cache" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ kind: "block-reason", reason: "Blocked: <path>", count: 1 })]);
});


it.each([
  ["Blocked: C:\\build\\cache id=abc123", "Blocked: <path> id=<id>"],
  ["Blocked: ./src/file.ts request=opaque-token", "Blocked: <path> request=<id>"],
  ["Blocked: file.ts call_abc123 550e8400-e29b-41d4-a716-446655440000", "Blocked: <path> <id> <id>"],
])("masks volatile block evidence in %s", (reason, masked) => {
  expect(maskBlockReason(reason)).toBe(masked);
});

it.each([
  "npm install a && npm test",
  "git diff | cat",
  "bash -c 'npm install'",
  "env TOKEN=value npm install",
  "npm install $(cat file)",
  "npm install 'unterminated",
])("declines command shapes whose shell structure cannot establish a command outcome: %s", command => {
  expect(commandShape(command)).toBeNull();
});

it("normalizes stored argv commands as well as quoted shell commands", () => {
  expect(commandShape('["git","diff","--stat","path with spaces.ts"]')).toBe("git diff --stat <args>");
});


it("masks paths attached to short flags and retains subcommands after global flags", () => {
  expect(commandShape("git -C /tmp/project diff --stat a.ts")).toBe("git diff --stat -C <args>");
  expect(commandShape("cc -I/tmp/include -c src/a.c")).toBe("cc -I -c <args>");
});
