import { afterEach, beforeEach, expect, it } from "vitest";
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
  db.prepare("INSERT INTO transcript_tool_calls (session_id, call_id, message_id, name, input, outcome, block_reason, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(session, String(callOrdinal), message.lastInsertRowid, options.name ?? "Bash", command, outcome, options.reason ?? null, options.truncated ?? 0);
}

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


it("restores lessons with counts and dates, without confidence scores", async () => {
  storedCall("session", "npm install old", "failed", { at: new Date().toISOString() });
  storedCall("session", "npm install new", "succeeded", { at: new Date().toISOString() });
  await lessons.refresh("project");
  const config = { compaction: { promotionThresholds: {} } } as DaemonConfig;
  const insights = readInsights(db, config);
  expect(insights).toHaveLength(1);
  expect(insights[0]).toMatchObject({ count: 1, sessionCount: 1, firstSeen: expect.any(String), lastSeen: expect.any(String) });
  expect(insights[0].content).toContain("npm install old");
  expect(insights[0].content).toContain("npm install new");
  expect(insights[0].content).toContain("1 occurrence");
  expect(insights[0]).not.toHaveProperty("confidence");
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
