import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { runLcmMigrations } from "../src/db/migration.js";
import { ensureToolLessonIncrementalSchema } from "../src/db/tool-lesson-schema.js";
import { readInsights } from "../src/daemon/restore/insights.js";
import type { DaemonConfig } from "../src/daemon/config.js";
import { commandShape, maskBlockReason, ToolLessonStore } from "../src/promotion/tool-lessons.js";
import { ToolLessonProjection } from "../src/promotion/tool-lesson-projection.js";

it.each([
  ["cd /tmp/private-work && npm install widget", "npm install <args>"],
  ["cd '/tmp/private work'; git diff --stat src/a.ts", "git diff --stat <args>"],
  ["TOKEN=private-value MODE=test npm install widget", "npm install <args>"],
  ["TOKEN='private value' mysql -psecret", "mysql -p <args>"],
  ["bash -lc 'npm install widget'", "npm install <args>"],
  ["sh -c 'git diff --stat src/a.ts'", "git diff --stat <args>"],
  ["zsh -lc 'mysql -psecret -uadmin'", "mysql -p -u <args>"],
  ['["bash","-lc","npm install widget"]', "npm install <args>"],
  ['["sh","-c","git diff --stat src/a.ts"]', "git diff --stat <args>"],
  ['["zsh","-lc","mysql -psecret -uadmin"]', "mysql -p -u <args>"],
  ["npm run build && npm test", "npm run <args> && npm test"],
  ["npm install widget || npm install other", "npm install <args> || npm install <args>"],
  ["git diff --stat src/a.ts; git status", "git diff --stat <args> ; git status"],
  ["git diff src/a.ts | cat", "git diff <args> | cat"],
  ["cd /tmp/private-work || npm test", "cd <args> || npm test"],
  ["bash -lc 'npm install widget || npm test' && git status", "(npm install <args> || npm test) && git status"],
  ["cd /tmp/private-work && bash -lc 'npm install widget || npm test'", "npm install <args> || npm test"],
  ["cd /tmp/private-work && TOKEN=private-value npm install widget && npm test", "npm install <args> && npm test"],
  ["bash -lc 'cd /tmp/private-work; TOKEN=private-value mysql -psecret | cat'", "mysql -p <args> | cat"],
  ["npm install 'quoted && value' && npm test", "npm install <args> && npm test"],
  ["npm install widget && git diff src/a.ts | cat; npm test", "npm install <args> && git diff <args> | cat ; npm test"],
])("shapes shell setup, wrappers and complete chains: %s", (command, shape) => {
  expect(commandShape(command)).toBe(shape);
});

it.each(["privatevalue", "/tmp/private-directory", "private quoted value", "a&&b|c;d"]) (
  "keeps values out of shapes across representative forms: %s", value => {
    const commands = [
      `cd '${value}' && mysql -p'${value}' -u'${value}' --output='${value}' '${value}'`,
      `TOKEN='${value}' OTHER='${value}' mysql -p'${value}'`,
      JSON.stringify(["bash", "-lc", `cd '${value}'; TOKEN='${value}' mysql -p'${value}' | cat '${value}'`]),
      `git '${value}'`,
      `npm install '${value}' && mysql -p'${value}'`,
    ];
    for (const command of commands) {
      const shape = commandShape(command);
      expect(shape).not.toBeNull();
      expect(shape).not.toContain(value);
      expect(shape).not.toContain("TOKEN");
      expect(shape).not.toContain("OTHER");
      expect(shape).not.toMatch(/["']/);
      expect(shape).toContain("<args>");
    }
  },
);

it("shapes more mixed shell calls while declining invalid and unsupported forms", () => {
  const commands = JSON.parse(readFileSync(new URL("./fixtures/tool-lesson-command-shapes.json", import.meta.url), "utf8")) as string[];
  expect(commands.map(commandShape).filter(Boolean)).toHaveLength(22);
});

it.each([
  "npm install widget && sudo npm test",
  "git diff | env TOKEN=value cat",
  "npm install widget &&",
  "npm install widget; ; npm test",
  "TOKEN=private-value",
  "bash -lc",
  "bash -lc 'npm install widget",
  `bash -lc "npm install 'unterminated"`,
  '["bash","-lc","npm install \\\"unterminated"]',
  "npm install widget && npm test 'unterminated",
  "npm install widget | npm test $(cat file)",
  "npm install widget > /tmp/output",
  "'TOKEN=private-value' npm test",
  "TOKEN\\=private-value npm test",
  "npm test # ignored && git status",
])("declines the whole command when parsing or any segment fails: %s", command => {
  expect(commandShape(command)).toBeNull();
});

it("bounds wrapper nesting and shapes chains and flags near the stored input cap", () => {
  const chain = Array.from({ length: 128 }, () => "npm test").join(" && ");
  expect(Buffer.byteLength(chain)).toBeLessThan(2048);
  expect(commandShape(chain)).toBe(chain);
  const flags = Array.from({ length: 100 }, (_, index) => `--flag${index}=value`);
  const command = "fixturetool " + flags.join(" ");
  expect(Buffer.byteLength(command)).toBeLessThan(2048);
  expect(commandShape(command)).toBe("fixturetool " + flags.map(flag => flag.split("=")[0]).sort().join(" ") + " <args>");
  const nested = (depth: number) => {
    let command = "npm test";
    while (depth--) command = "bash -c " + JSON.stringify(command);
    return command;
  };
  expect(Buffer.byteLength(nested(9))).toBeLessThan(2048);
  expect(commandShape(nested(9))).toBeNull();
  expect(commandShape(nested(8))).toBe("npm test");
  expect(commandShape(`bash -lc 'bash -c "npm test"'`)).toBe("npm test");
});

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

it.each(["&&", "||", ";", "|"])("keeps %s chain evidence separate from every segment", async operator => {
  const shape = `npm install <args> ${operator} npm test`;
  const now = new Date().toISOString();
  for (const session of ["one", "two", "three"]) {
    storedCall(session, `npm install old ${operator} npm test`, "failed", { at: now });
    storedCall(session, "npm install new", "succeeded", { at: now });
    storedCall(session, "npm test", "succeeded", { at: now });
  }
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ kind: "environment-rule", shape, count: 3, retired: false })]);
  const insights = readInsights(db, { compaction: { promotionThresholds: {} } } as DaemonConfig);
  expect(insights).toHaveLength(1);
  expect(insights[0].content).toContain(`\`${shape}\``);

  storedCall("one", `npm install new ${operator} npm test`, "succeeded", { at: now });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ kind: "error-fix", shape, count: 1 })]);
  expect(lessons.list({ kind: "environment-rule", includeRetired: true })).toEqual([
    expect.objectContaining({ shape, retired: true }),
  ]);
});

it("does not retire a single-segment rule with a successful chain", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "npm test", "failed");
  storedCall("success", "npm install widget && npm test", "succeeded", { at: "2026-01-03T00:00:00Z" });
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ shape: "npm test", retired: false })]);
  expect(commandShape("npm install widget && npm test")).toBe("npm install <args> && npm test");
});

it("declines truncated wrapper calls even when their visible command has a shape", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "bash -lc 'npm install widget'", "failed");
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ shape: "npm install <args>" })]);
  db.exec("UPDATE transcript_tool_calls SET truncated = 1");
  await lessons.refresh("project");
  expect(lessons.list()).toEqual([]);
});

it("re-derives shapes once on stores that already have the incremental schema", async () => {
  for (const session of ["one", "two", "three"]) {
    storedCall(session, "git privatevalue", "failed");
    storedCall(session, "bash -lc 'cd /tmp/private-work; TOKEN=private-value npm install widget'", "failed");
  }
  storedCall("success", "sh -c 'git privatevalue'", "succeeded", { at: "2026-01-03T00:00:00Z" });
  const changed = storedCall("pending", "Read", "unknown", { name: "Read" });
  await lessons.refresh("project");
  const legacy = { ...lessons.list({ kind: "environment-rule", includeRetired: true }).find(lesson => lesson.shape === "git privatevalue")!, shape: "git privatevalue" };
  // The old parser retained quoted subcommands; the new format masks them.
  db.prepare("UPDATE transcript_tool_calls SET input = ? WHERE input = 'git privatevalue'").run("git 'privatevalue'");
  db.prepare("UPDATE transcript_tool_calls SET input = ? WHERE input LIKE 'sh -c %'").run(`sh -c "git 'privatevalue'"`);
  const key = JSON.stringify(["environment-rule", legacy.shape]);
  const legacyContribution = { ...legacy, count: 1, sessionCounts: {} };
  for (const row of db.prepare("SELECT call_row, session_id FROM tool_lesson_contributions WHERE lesson_key = ?").all(key)) {
    db.prepare("UPDATE tool_lesson_contributions SET data = ? WHERE call_row = ? AND kind = 'environment-rule'")
      .run(JSON.stringify({ ...legacyContribution, sessionCounts: { [String(row.session_id)]: 1 } }), row.call_row);
  }
  db.exec("DELETE FROM tool_lesson_changes; DROP TABLE IF EXISTS tool_lesson_shape_backfill");
  db.prepare("INSERT INTO tool_lesson_changes SELECT session_id, call_id FROM transcript_tool_calls WHERE rowid = ?").run(changed);
  const published = lessons.list({ includeRetired: true });
  const generation = db.prepare("SELECT generation FROM tool_lesson_state").get()!.generation;

  runLcmMigrations(db);
  expect(lessons.list({ includeRetired: true })).toEqual(published);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tool_lesson_changes").get()!.count).toBe(8);
  runLcmMigrations(db);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tool_lesson_changes").get()!.count).toBe(8);
  await new ToolLessonStore(db).refresh("project");
  expect(lessons.list({ kind: "environment-rule", includeRetired: true })).toEqual(expect.arrayContaining([
    expect.objectContaining({ shape: "git <args>", count: 3, retired: true }),
    expect.objectContaining({ shape: "npm install <args>", count: 3, retired: false }),
  ]));
  for (const table of ["tool_lessons", "tool_lesson_contributions", "tool_lesson_totals"]) {
    expect(db.prepare(`SELECT 1 FROM ${table} WHERE lesson_key = ?`).get(key)).toBeUndefined();
  }
  expect(db.prepare("SELECT 1 FROM tool_lesson_successes WHERE shape = 'git privatevalue'").get()).toBeUndefined();
  expect(db.prepare("SELECT generation FROM tool_lesson_state").get()!.generation).toBe(Number(generation) + 1);
  runLcmMigrations(db);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tool_lesson_changes").get()!.count).toBe(0);
  expect(await lessons.refresh("project")).toBe(0);
  expect(db.prepare("SELECT generation FROM tool_lesson_state").get()!.generation).toBe(Number(generation) + 1);
});

it("commits the shape-upgrade journal and marker together and retries after rollback", async () => {
  storedCall("one", "bash -lc 'npm install widget'", "failed");
  await lessons.refresh("project");
  db.exec(`DELETE FROM tool_lesson_shape_backfill;
    CREATE TRIGGER fail_shape_marker BEFORE INSERT ON tool_lesson_shape_backfill BEGIN
      SELECT RAISE(ABORT, 'interrupted shape upgrade');
    END;`);
  expect(() => ensureToolLessonIncrementalSchema(db)).toThrow("interrupted shape upgrade");
  expect(db.prepare("SELECT 1 FROM tool_lesson_changes").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM tool_lesson_shape_backfill").get()).toBeUndefined();
  db.exec("DROP TRIGGER fail_shape_marker");
  ensureToolLessonIncrementalSchema(db);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tool_lesson_changes").get()!.count).toBe(1);
  expect(db.prepare("SELECT id FROM tool_lesson_shape_backfill").get()!.id).toBe(1);
  await lessons.refresh("project");
  ensureToolLessonIncrementalSchema(db);
  expect(db.prepare("SELECT 1 FROM tool_lesson_changes").get()).toBeUndefined();
});

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

it("derives a window's pairs and block reasons from the selected messages only", async () => {
  const messageIds = (...rows: number[]) => rows.map(row =>
    Number(db.prepare("SELECT message_id FROM transcript_tool_calls WHERE rowid = ?").get(row)!.message_id));
  const reads = (session: string, count: number) => Array.from({ length: count }, (_, i) =>
    storedCall(session, `/tmp/${session}-${i}`, "succeeded", { name: "Read" }));
  const failed = storedCall("one", "npm install widget@1", "failed");
  const blocked = storedCall("one", "make deploy", "blocked", { reason: "PreToolUse:Bash hook error: deploy 42 is disabled" });
  const fillers = reads("one", 18);
  const fixed = storedCall("one", "npm install widget@2", "succeeded");
  const window = messageIds(failed, blocked, ...fillers, fixed);

  const derived = await lessons.forMessages(window);
  expect(derived.find(lesson => lesson.kind === "error-fix"))
    .toMatchObject({ failedCommand: "npm install widget@1", succeededCommand: "npm install widget@2", count: 1 });
  expect(derived.find(lesson => lesson.kind === "block-reason")?.reason).toBe(maskBlockReason("PreToolUse:Bash hook error: deploy 42 is disabled"));
  expect(derived.some(lesson => lesson.kind === "environment-rule")).toBe(false);

  // The fix outside the selected messages does not pair.
  expect((await lessons.forMessages(window.slice(0, -1))).some(lesson => lesson.kind === "error-fix")).toBe(false);
  // Twenty intervening calls of any tool put the fix outside the 20-call window.
  const late = storedCall("two", "npm install widget@1", "failed");
  const lateFillers = reads("two", 20);
  const lateFix = storedCall("two", "npm install widget@2", "succeeded");
  expect((await lessons.forMessages(messageIds(late, ...lateFillers, lateFix))).some(lesson => lesson.kind === "error-fix")).toBe(false);
});

it("keeps distinct blocked command/reason pairs in the window without changing published lessons", async () => {
  const rows = [
    storedCall("one", "make deploy", "blocked", { reason: "disabled 42" }),
    storedCall("one", "make deploy", "blocked", { reason: "disabled 43" }),
    storedCall("one", "make release", "blocked", { reason: "disabled 44" }),
    storedCall("one", "make deploy", "blocked", { reason: "permission denied" }),
  ];
  const ids = rows.map(row => Number(db.prepare("SELECT message_id FROM transcript_tool_calls WHERE rowid = ?").get(row)!.message_id));
  const blocked = (await lessons.forMessages(ids)).filter(lesson => lesson.kind === "block-reason");
  expect(blocked.map(({ command, reason }) => ({ command, reason }))).toEqual([
    { command: "make deploy", reason: "disabled <id>" },
    { command: "make release", reason: "disabled <id>" },
    { command: "make deploy", reason: "permission denied" },
  ]);
  await lessons.refresh("project");
  const published = lessons.list({ kind: "block-reason" });
  expect(published).toHaveLength(2);
  expect(published.find(lesson => lesson.reason === "disabled <id>")?.count).toBe(3);
  for (const lesson of published) expect(lesson).not.toHaveProperty("command");
});

it("evaluates each call's pair once when a whole session is journaled across pages", async () => {
  const rows = Array.from({ length: 300 }, (_, index) =>
    storedCall("session", `npm install package-${index}`, index % 8 === 7 ? "succeeded" : "failed"));
  const replace = ToolLessonProjection.prototype.replaceContribution;
  const evaluated: number[] = [];
  const spy = vi.spyOn(ToolLessonProjection.prototype, "replaceContribution").mockImplementation(function (...args) {
    if (args[1] === "error-fix") evaluated.push(args[0]);
    return replace.apply(this, args);
  });
  try {
    await lessons.refresh("project");
    expect(evaluated.sort((a, b) => a - b)).toEqual(rows);
  } finally { spy.mockRestore(); }
});

it("parses each call's shape once within a page, including commands without a shape", async () => {
  const commands = Array.from({ length: 60 }, (_, index) => JSON.stringify(index % 3 === 0
    ? ["bash", "-c", `npm install package-${index}`] : ["npm", "install", `package-${index}`]));
  commands.forEach((command, index) => storedCall("session", command, index % 3 === 2 ? "succeeded" : "failed"));
  const parse = JSON.parse;
  const counts = new Map<string, number>();
  const spy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
    if (commands.includes(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return parse(value, reviver);
  });
  try {
    await lessons.refresh("project");
    expect([...counts.values()]).toEqual(commands.map(() => 1));
  } finally { spy.mockRestore(); }
});

it("yields after a slow call update before updating the next call, outside its transaction", async () => {
  for (let index = 0; index < 3; index++) storedCall("session", `npm install package-${index}`, "succeeded");
  let elapsed = 0, transactions = 0, steps = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const exec = db.exec.bind(db);
  const transaction = vi.spyOn(db, "exec").mockImplementation(sql => {
    exec(sql);
    if (sql.startsWith("SAVEPOINT")) transactions++;
    if (sql.includes("RELEASE")) transactions--;
  });
  const record = ToolLessonProjection.prototype.recordSuccess;
  const update = vi.spyOn(ToolLessonProjection.prototype, "recordSuccess").mockImplementation(function (...args) {
    record.apply(this, args);
    steps++;
    if (steps === 1) elapsed = 100;
  });
  const observed: number[] = [];
  const timer = new Promise<void>(resolve => setImmediate(() => {
    observed.push(steps, transactions);
    resolve();
  }));
  try {
    await lessons.refresh("project");
    await timer;
    expect(observed).toEqual([1, 0]);
  } finally {
    update.mockRestore(); transaction.mockRestore(); clock.mockRestore();
  }
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

it("keeps a page journaled when pair publication is interrupted after call contributions", async () => {
  await lessons.refresh("project");
  for (let index = 0; index < 2; index++) {
    storedCall("session", `npm install old-${index}`, "failed");
    storedCall("session", `npm install new-${index}`, "succeeded");
  }
  const replace = ToolLessonProjection.prototype.replaceContribution;
  let pairs = 0;
  const spy = vi.spyOn(ToolLessonProjection.prototype, "replaceContribution").mockImplementation(function (...args) {
    if (args[1] === "error-fix" && ++pairs === 3) throw new Error("pair update interrupted");
    return replace.apply(this, args);
  });
  try {
    await expect(lessons.refresh("project")).rejects.toThrow("pair update interrupted");
    expect(db.prepare("SELECT count(*) AS n FROM tool_lesson_changes").get()!.n).toBe(4);
    expect(lessons.list()).toEqual([]);
  } finally { spy.mockRestore(); }
  const fresh = rebuiltSnapshot();
  try {
    expect(await new ToolLessonStore(db).refresh("project")).toBe(await fresh.store.refresh("project"));
    expect(lessons.list({ includeRetired: true })).toEqual(fresh.store.list({ includeRetired: true }));
  } finally { fresh.db.close(); }
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
  const artifacts = db.prepare("SELECT type, name FROM sqlite_master WHERE name GLOB 'tool_lesson_*' AND name <> 'tool_lesson_state' ORDER BY type DESC").all();
  for (const artifact of artifacts) {
    if (artifact.type === "trigger" || artifact.type === "table") db.exec(`DROP ${String(artifact.type)} ${String(artifact.name)}`);
  }
  runLcmMigrations(db);
  await new ToolLessonStore(db).refresh("project");
  expect(lessons.list()).toEqual([expect.objectContaining({ shape: "mysql -p <args>", count: 3 })]);
  runLcmMigrations(db);
  expect(await lessons.refresh("project")).toBe(0);
});

it("drops rows an interrupted older publish left outside the published generation", async () => {
  for (const session of ["one", "two", "three"]) storedCall(session, "make build", "failed");
  await lessons.refresh("project");
  const { generation } = db.prepare("SELECT generation FROM tool_lesson_state").get() as { generation: number };
  const [published] = lessons.list();
  const orphan = (shape: string, at: number) => db.prepare("INSERT INTO tool_lessons (generation, lesson_key, kind, retired, last_seen, data) VALUES (?, ?, 'environment-rule', 0, ?, ?)")
    .run(at, JSON.stringify(["environment-rule", shape]), published.lastSeen, JSON.stringify({ ...published, shape }));
  orphan("make below", generation - 1);
  orphan("make above", generation + 1);
  const artifacts = db.prepare("SELECT type, name FROM sqlite_master WHERE name GLOB 'tool_lesson_*' AND name <> 'tool_lesson_state' ORDER BY type DESC").all();
  for (const artifact of artifacts) {
    if (artifact.type === "trigger" || artifact.type === "table") db.exec(`DROP ${String(artifact.type)} ${String(artifact.name)}`);
  }
  runLcmMigrations(db);
  expect(db.prepare("SELECT count(*) AS n FROM tool_lessons WHERE generation <> ?").get(generation)!.n).toBe(0);
  await new ToolLessonStore(db).refresh("project");
  storedCall("four", "make build", "failed");
  await new ToolLessonStore(db).refresh("project");
  expect(lessons.list().map(lesson => lesson.shape)).toEqual([published.shape]);
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
