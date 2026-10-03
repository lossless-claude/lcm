import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { runLcmMigrations } from "../src/db/migration.js";
import { registerDiagnosticsCommands } from "../src/cli/diagnostics.js";
import { estimateTokens } from "../src/transcript.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { projectDbPath } from "../src/daemon/project.js";

let db: DatabaseSync, ordinal: number;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  ordinal = 0;
});
afterEach(() => db.close());

function call(session: string, outcome: string, options: {
  command?: string | null; name?: string; at?: string | null; captured?: string;
  truncated?: boolean; message?: number;
} = {}): number {
  db.prepare("INSERT INTO conversations (session_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE session_id = ?)")
    .run(session, session);
  const conversation = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(session)!;
  ordinal++;
  const message = options.message ?? Number(db.prepare(`INSERT INTO messages
    (conversation_id, seq, role, content, token_count, event_at, created_at)
    VALUES (?, ?, 'tool', 'fixture', 1, ?, ?)`)
    .run(conversation.conversation_id, ordinal, options.at === undefined ? "2026-01-01T00:00:00Z" : options.at,
      options.captured ?? "2026-01-01T00:00:00Z").lastInsertRowid);
  db.prepare(`INSERT INTO transcript_tool_calls (session_id, call_id, message_id, name, input, outcome, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(session, String(ordinal), message, options.name ?? "Bash",
      options.command === undefined ? "npm install widget" : options.command, outcome, options.truncated ? 1 : 0);
  return message;
}

async function measure() {
  const { backtestWarnings } = await import("../src/warning-backtest.js");
  return backtestWarnings(db);
}

function seed(command?: string): void {
  for (const session of ["one", "two", "three"]) call(session, "failed", { command });
}

it("activates only after the third distinct failing session, never on its own evidence", async () => {
  for (let index = 0; index < 6; index++) call("one", "failed");
  call("two", "blocked");
  call("three", "failed");
  expect(await measure()).toMatchObject({ matches: 0, unmatchedFailures: 8 });
  call("four", "blocked");
  expect(await measure()).toMatchObject({ matches: 1, matchedFailures: 1, unmatchedFailures: 8 });
});

it("retires forever on a success after the first failure, even before activation", async () => {
  call("one", "failed");
  call("success", "succeeded");
  for (const session of ["two", "three", "four", "five"]) call(session, "failed");
  expect(await measure()).toMatchObject({ matches: 0, unmatchedFailures: 5 });
});

it("matches the retiring success itself using only evidence strictly before that call", async () => {
  call("early-success", "succeeded");
  seed();
  call("success", "succeeded");
  call("later", "failed");
  expect(await measure()).toMatchObject({ matches: 1, resolvedMatches: 1, matchedFailures: 0, unmatchedFailures: 4 });
});

it("orders by transcript time, with capture-time fallback and message id breaking ties", async () => {
  call("later", "failed", { at: "2026-01-03T00:00:00Z" });
  call("one", "failed");
  call("two", "failed", { at: null });
  call("three", "blocked");
  const report = await measure();
  expect(report).toMatchObject({ matches: 1, matchedFailures: 1, unmatchedFailures: 3 });
  expect(report.contextCost.totalBytes).toBe(Buffer.byteLength(ruleLine(3)));
});

it("uses rowid to order multiple calls on the same message", async () => {
  seed();
  const message = call("four", "unknown");
  call("four", "succeeded", { message });
  call("four", "failed", { message });
  expect(await measure()).toMatchObject({ matches: 2, resolvedMatches: 1, matchedFailures: 0, unmatchedFailures: 4 });
});

it("excludes worker evidence and worker matches in every worker state", async () => {
  call("one", "failed");
  call("two", "failed");
  for (const state of ["active", "finished", "abandoned"]) {
    call(state, "failed");
    db.prepare("INSERT INTO summarize_workers (session_id, cwd, client, state) VALUES (?, '/project', 'claude', ?)").run(state, state);
  }
  call("three", "failed");
  call("active", "succeeded");
  call("four", "failed");
  expect(await measure()).toMatchObject({ calls: 4, matches: 1, matchedFailures: 1, unmatchedFailures: 3 });
});

it("reuses shell-tool recognition and shapes that mask attached values", async () => {
  call("one", "failed", { command: "mysql -pfirst", name: "functions.exec_command" });
  call("two", "blocked", { command: '["mysql","-psecond"]', name: "shell_command" });
  call("three", "failed", { command: "mysql -p third", name: "bash" });
  call("four", "blocked", { command: "mysql -pfourth", name: "shell" });
  expect(await measure()).toMatchObject({ matches: 1, matchedFailures: 1, unmatchedFailures: 3 });
});

it("keeps non-shell, truncated and shapeless failures outside coverage", async () => {
  seed();
  call("four", "failed");
  call("five", "failed", { name: "Read" });
  call("six", "failed", { truncated: true });
  // A redirection has no shape; chains do since #796.
  call("seven", "blocked", { command: "npm install a > install.log" });
  call("eight", "failed", { command: null });
  expect(await measure()).toMatchObject({ calls: 8, shapedCalls: 4, matches: 1, matchedFailures: 1,
    unmatchedFailures: 3, unshapedFailures: 3, coverage: 1 / 4 });
});

function ruleLine(sessions: number): string {
  return `Environment rule: \`npm install <args>\` failed or was blocked in ${sessions} sessions, with no success since (last 2026-01-01).`;
}

it("reports precision, coverage, excluded matched outcomes and total/average/max session cost", async () => {
  seed();
  call("one", "blocked");
  call("four", "failed");
  for (const outcome of ["unknown", "denied", "interrupted", "succeeded"]) call("one", outcome);
  call("five", "failed");
  const report = await measure();
  const bytes = Buffer.byteLength(ruleLine(3)), tokens = estimateTokens(ruleLine(3));
  expect(report).toMatchObject({ status: "measured", calls: 10, shapedCalls: 10, matches: 6,
    resolvedMatches: 3, matchedFailures: 2, unmatchedFailures: 4, precision: 2 / 3, coverage: 2 / 6,
    excludedOutcomes: { unknown: 1, denied: 1, interrupted: 1 },
    contextCost: { sessions: 2, totalBytes: bytes * 6, totalTokens: tokens * 6,
      averageBytes: bytes * 3, averageTokens: tokens * 3, maxBytes: bytes * 5, maxTokens: tokens * 5 } });
  const { formatWarningBacktest } = await import("../src/warning-backtest.js");
  const text = formatWarningBacktest(report);
  for (const phrase of ["warnings stay off", "6 matches", "66.7%", "33.3%", "4 failing calls had no match",
    "unknown: 1", "denied: 1", "interrupted: 1", "UTF-8 bytes", "estimated tokens", "average", "maximum", "actually injected: 0"]) {
    expect(text).toContain(phrase);
  }
});

it("reports no stored calls as unknown, rather than zero-valued measurements", async () => {
  const report = await measure();
  expect(report).toMatchObject({ status: "no-data", precision: null, coverage: null });
  const { formatWarningBacktest } = await import("../src/warning-backtest.js");
  expect(formatWarningBacktest(report)).toContain("No stored calls; precision, coverage and context cost are unknown.");
});

it("reads each call once in bounded pages without writing the source or deriving lessons", async () => {
  seed();
  for (let index = 0; index < 300; index++) call("session-" + index, "unknown");
  const before = db.prepare("SELECT total_changes() AS n").get()!.n;
  const spy = vi.spyOn(db, "prepare");
  const report = await measure();
  expect(report).toMatchObject({ calls: 303, matches: 300, contextCost: { sessions: 300 } });
  const queries = spy.mock.calls.map(([sql]) => sql).filter(sql => /FROM transcript_tool_calls/i.test(sql));
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("ORDER BY seen, t.message_id, t.rowid");
  expect(queries[0]).not.toMatch(/OFFSET/i);
  expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM tool_lessons").get()!.n).toBe(0);
  spy.mockRestore();
});

it("makes the backtest an explicit stats option without starting a daemon", async () => {
  const daemon = vi.fn(() => { throw new Error("must run offline"); });
  const program = new Command();
  registerDiagnosticsCommands(program, { createDaemonClientOrExit: daemon });
  const stats = program.commands.find(command => command.name() === "stats")!;
  expect(stats.options.map(option => option.long)).toContain("--warning-backtest");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await program.parseAsync(["stats", "--warning-backtest"], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("No stored calls; precision, coverage and context cost are unknown.");
    // The all-project inventory is not printed with the single-project backtest.
    expect(log.mock.calls.flat().join("\n")).not.toContain("lossless-claude");
    expect(daemon).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

const cli = fileURLToPath(new URL("../dist/bin/lcm.js", import.meta.url));

it("runs the built operator command on a read-only fixture without changing the store", () => {
  seed();
  call("four", "blocked");
  const paths = createLcmPaths(process.env.LCM_HOME!);
  const path = projectDbPath(process.cwd(), paths);
  mkdirSync(dirname(path), { recursive: true });
  db.prepare("VACUUM INTO ?").run(path);
  const before = readFileSync(path);
  const result = spawnSync(process.execPath, [cli, "stats", "--warning-backtest"], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("1 matches / 4 shaped shell calls");
  expect(result.stdout).toContain("Precision 100.0%");
  expect(result.stdout).toContain("Coverage 25.0%");
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(paths.pidPath)).toBe(false);
});

it.each(["--pool", "--json"])("rejects incompatible %s before contacting a daemon", flag => {
  const result = spawnSync(process.execPath, [cli, "stats", "--warning-backtest", flag], { encoding: "utf8", timeout: 10_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--warning-backtest cannot be combined with --pool or --json");
});
