import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SHELL_TOOLS, type ToolOutcome } from "../tool-calls.js";
import { yieldToEventLoop } from "../daemon/project-queue.js";
import { BATCH_SIZE, ToolLessonProjection, withLessonTransaction } from "./tool-lesson-projection.js";

const SUBCOMMAND_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "pip", "pip3", "brew", "cargo", "docker", "kubectl", "gh", "lcm"]);

/** Deliberately accepts one simple command; shell control flow cannot prove the executable's outcome. */
function commandWords(command: string): string[] | null {
  if (command.startsWith("[")) {
    try {
      const words: unknown = JSON.parse(command);
      return Array.isArray(words) && words.every(word => typeof word === "string") ? words : null;
    } catch { return null; }
  }
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (++index === command.length) return null;
      word += command[index]; started = true; continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && /[$`]/.test(char)) return null;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/[;&|<>$`\n\r()]/.test(char)) return null;
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = ""; started = false; continue;
    }
    word += char; started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words.length ? words : null;
}

const GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--prefix", "--cwd", "--directory", "--git-dir", "--work-tree", "--config"]);

function subcommandIndex(words: readonly string[], executable: string): number {
  if (!SUBCOMMAND_TOOLS.has(executable)) return -1;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === "--") return -1;
    if (GLOBAL_VALUE_FLAGS.has(word)) { index++; continue; }
    if (word.startsWith("-")) continue;
    return /^[a-z][\w-]*$/.test(word) ? index : -1;
  }
  return -1;
}

function shapeFlag(word: string, executable: string): { name: string; hasValue: boolean } {
  // Only rm's documented value-free flags can establish a cluster. An unknown
  // executable may take a value on its first short flag, even when it looks like -rf.
  if (/^-[a-zA-Z].+/.test(word)) {
    if (executable === "rm" && /^-[dfiPRrvW]+$/.test(word)) return { name: word, hasValue: false };
    return { name: word.slice(0, 2), hasValue: true };
  }
  const equals = word.indexOf("=");
  if (equals >= 0) return { name: word.slice(0, equals), hasValue: true };
  return { name: word, hasValue: false };
}

/** Values share one placeholder so attached and separated flag values form the same shape. */
export function commandShape(command: string): string | null {
  const words = commandWords(command);
  if (!words?.length) return null;
  const executable = basename(words[0]);
  if (!/^[a-zA-Z][\w.-]*$/.test(executable)) return null;
  if (["sh", "bash", "zsh", "env", "sudo", "xargs"].includes(executable)) return null;
  const parts = [executable];
  const subcommand = subcommandIndex(words, executable);
  if (subcommand > 0) parts.push(words[subcommand]);
  const flags = new Set<string>();
  let hasValues = false, positional = false;
  for (let index = 1; index < words.length; index++) {
    if (index === subcommand) continue;
    const word = words[index];
    if (word === "--") { positional = true; continue; }
    if (!positional && /^--?[a-zA-Z]/.test(word)) {
      const flag = shapeFlag(word, executable);
      flags.add(flag.name);
      hasValues ||= flag.hasValue;
    } else hasValues = true;
  }
  return [...parts, ...[...flags].sort(), ...(hasValues ? ["<args>"] : [])].join(" ");
}

const CALL_WINDOW = 20;

export interface ToolLesson {
  kind: "error-fix" | "block-reason" | "environment-rule";
  shape?: string;
  reason?: string;
  failedCommand?: string;
  succeededCommand?: string;
  count: number;
  sessionCounts: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  retired: boolean;
  tags: string[];
}

export interface StoredCall {
  row_id: number; session_id: string; message_id: number; name: string;
  input: string | null; outcome: ToolOutcome; block_reason: string | null;
  truncated: number; seen: string;
}

function observe(lesson: ToolLesson, call: StoredCall): void {
  lesson.count++;
  lesson.sessionCounts[call.session_id] = (lesson.sessionCounts[call.session_id] ?? 0) + 1;
  lesson.firstSeen = lesson.firstSeen < call.seen ? lesson.firstSeen : call.seen;
  lesson.lastSeen = lesson.lastSeen > call.seen ? lesson.lastSeen : call.seen;
}

function newLesson(kind: ToolLesson["kind"], call: StoredCall, project: string): ToolLesson {
  const type = kind === "error-fix" ? "solution" : kind === "block-reason" ? "gotcha" : "environment";
  return { kind, count: 0, sessionCounts: Object.create(null) as Record<string, number>,
    firstSeen: call.seen, lastSeen: call.seen, retired: false,
    tags: [`type:${type}`, "source:tool-calls", `project:${project}`] };
}

/** Keep the reason's wording while removing volatile paths and identifiers. */
export function maskBlockReason(reason: string): string {
  return reason.split(/\r?\n/, 1)[0]
    .replace(/(?:[A-Za-z]:[\\/]|(?:~|\.\.?)?\/)[^\s"'<>]+|\b[\w.-]+\/[^\s"'<>]+/g, "<path>")
    .replace(/\b[\w-]+\.[\w.-]+\b/g, "<path>")
    .replace(/\b(?:session|call|request)[_-][\w-]+\b/gi, "<id>")
    .replace(/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,})\b/gi, "<id>")
    .replace(/(\b(?:[\w-]*id|pid|session|call|request)[=:]\s*)[^\s,;]+/gi, "$1<id>")
    .replace(/\b\d+\b/g, "<id>");
}

export function callShape(call: StoredCall): string | null {
  if (!SHELL_TOOLS.includes(call.name.replace(/^functions\./, "").toLowerCase()) || call.input === null || call.truncated) return null;
  return commandShape(call.input);
}

function blockLesson(call: StoredCall, project: string): ToolLesson | undefined {
  if (!SHELL_TOOLS.includes(call.name.replace(/^functions\./, "").toLowerCase())) return;
  if (call.outcome !== "blocked" || !call.block_reason) return;
  const lesson = { ...newLesson("block-reason", call, project), reason: maskBlockReason(call.block_reason) };
  observe(lesson, call);
  return lesson;
}

function environmentLesson(call: StoredCall, project: string): ToolLesson | undefined {
  const shape = callShape(call);
  if (!shape || (call.outcome !== "failed" && call.outcome !== "blocked")) return;
  const lesson = { ...newLesson("environment-rule", call, project), shape };
  observe(lesson, call);
  return lesson;
}

export const CALL_SELECT = `SELECT t.rowid AS row_id, t.*,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', m.event_at), strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at)) AS seen
  FROM transcript_tool_calls t JOIN messages m ON m.message_id = t.message_id`;

/** Refreshes journaled calls and their bounded pairing windows. Callers hold the project mutation lease. */
export class ToolLessonStore {
  private readonly projection: ToolLessonProjection;
  constructor(private readonly db: DatabaseSync) { this.projection = new ToolLessonProjection(db); }

  async refresh(project: string): Promise<number> {
    const state = this.db.prepare("SELECT generation FROM tool_lesson_state WHERE singleton = 1").get() as { generation: number } | undefined;
    const invalid = this.db.prepare("SELECT session_id FROM tool_lesson_invalid_sessions ORDER BY session_id LIMIT 1");
    while (true) {
      const session = invalid.get() as { session_id: string } | undefined;
      if (!session) break;
      await this.invalidateSession(session.session_id);
    }

    await this.refreshChanges(project);
    const pending = this.db.prepare("SELECT pending FROM tool_lesson_progress WHERE singleton = 1").get()!.pending;
    if (state && !pending && !this.db.prepare("SELECT 1 FROM tool_lesson_totals WHERE dirty = 1 LIMIT 1").get()) return 0;
    await this.projection.publish((state?.generation ?? 0) + 1);
    return Number(this.db.prepare("SELECT pair_count FROM tool_lesson_progress WHERE singleton = 1").get()!.pair_count);
  }

  private async refreshChanges(project: string): Promise<void> {
    const changes = this.db.prepare("SELECT session_id, call_id FROM tool_lesson_changes ORDER BY session_id, call_id LIMIT ?");
    const callById = this.db.prepare(CALL_SELECT + `
      WHERE t.session_id = ? AND t.call_id = ?
      AND NOT EXISTS (SELECT 1 FROM summarize_workers w WHERE w.session_id = t.session_id)`);
    while (true) {
      const page = changes.all(BATCH_SIZE) as { session_id: string; call_id: string }[];
      if (!page.length) break;
      for (const change of page) {
        withLessonTransaction(this.db, () => {
          const call = callById.get(change.session_id, change.call_id) as unknown as StoredCall | undefined;
          if (call) this.updateCall(call, project);
          this.db.prepare("DELETE FROM tool_lesson_changes WHERE session_id = ? AND call_id = ?").run(change.session_id, change.call_id);
          this.db.prepare("UPDATE tool_lesson_progress SET pending = 1 WHERE singleton = 1").run();
        });
      }
      await yieldToEventLoop();
    }
  }

  private updateCall(call: StoredCall, project: string): void {
    const shape = callShape(call);
    this.projection.replaceContribution(call.row_id, "block-reason", { call, lesson: blockLesson(call, project) });
    this.projection.replaceContribution(call.row_id, "environment-rule", { call, lesson: environmentLesson(call, project) });
    this.projection.removeSuccess(call.row_id);
    if (shape && call.outcome === "succeeded") {
      this.projection.recordSuccess(call, shape);
    }
    // Insertion or resolution can change only this call and failures in its
    // preceding window. Non-shell calls still consume positions in that window.
    const previous = this.db.prepare(CALL_SELECT + `
      WHERE t.session_id = ? AND (t.message_id, t.rowid) < (?, ?)
      ORDER BY t.message_id DESC, t.rowid DESC LIMIT ?`)
      .all(call.session_id, call.message_id, call.row_id, CALL_WINDOW) as unknown as StoredCall[];
    for (const failure of [call, ...previous]) this.updatePair(failure, project);
  }

  private updatePair(call: StoredCall, project: string): void {
    let pair: ToolLesson | undefined;
    const shape = callShape(call);
    if (shape && (call.outcome === "failed" || call.outcome === "blocked")) {
      const window = this.db.prepare(CALL_SELECT + `
        WHERE t.session_id = ? AND (t.message_id, t.rowid) > (?, ?)
        ORDER BY t.message_id, t.rowid LIMIT ?`)
        .all(call.session_id, call.message_id, call.row_id, CALL_WINDOW) as unknown as StoredCall[];
      const success = window.find(next => next.outcome === "succeeded" && callShape(next) === shape);
      if (success) {
        pair = { ...newLesson("error-fix", call, project), shape,
          failedCommand: call.input!, succeededCommand: success.input! };
        observe(pair, call);
        pair.lastSeen = pair.lastSeen > success.seen ? pair.lastSeen : success.seen;
      }
    }
    this.projection.replaceContribution(call.row_id, "error-fix", { call, lesson: pair });
  }

  /** Only deletion/movement/exclusion replays a session, including pairs whose window shrank. */
  private async invalidateSession(session: string): Promise<void> {
    const evidence = this.db.prepare("SELECT call_row, kind FROM tool_lesson_contributions WHERE session_id = ? ORDER BY call_row, kind LIMIT ?");
    while (true) {
      const page = evidence.all(session, BATCH_SIZE) as { call_row: number; kind: ToolLesson["kind"] }[];
      if (!page.length) break;
      withLessonTransaction(this.db, () => { for (const row of page) this.projection.replaceContribution(row.call_row, row.kind); });
      await yieldToEventLoop();
    }
    const successes = this.db.prepare("SELECT call_row FROM tool_lesson_successes WHERE session_id = ? ORDER BY call_row LIMIT ?");
    while (true) {
      const page = successes.all(session, BATCH_SIZE) as { call_row: number }[];
      if (!page.length) break;
      withLessonTransaction(this.db, () => { for (const row of page) this.projection.removeSuccess(row.call_row); });
      await yieldToEventLoop();
    }
    withLessonTransaction(this.db, () => {
      this.db.prepare("DELETE FROM tool_lesson_changes WHERE session_id = ?").run(session);
      this.db.prepare(`INSERT OR IGNORE INTO tool_lesson_changes
        SELECT session_id, call_id FROM transcript_tool_calls WHERE session_id = ?
          AND NOT EXISTS (SELECT 1 FROM summarize_workers WHERE session_id = ?)`).run(session, session);
      this.db.prepare("DELETE FROM tool_lesson_invalid_sessions WHERE session_id = ?").run(session);
      this.db.prepare("UPDATE tool_lesson_progress SET pending = 1 WHERE singleton = 1").run();
    });
  }

  list(options: { kind?: ToolLesson["kind"]; limit?: number; includeRetired?: boolean } = {}): ToolLesson[] {
    return this.db.prepare(`SELECT t.data FROM tool_lessons t
      WHERE t.generation <= (SELECT generation FROM tool_lesson_state WHERE singleton = 1)
        AND t.generation = (SELECT MAX(v.generation) FROM tool_lessons v WHERE v.lesson_key = t.lesson_key
          AND v.generation <= (SELECT generation FROM tool_lesson_state WHERE singleton = 1))
        AND t.kind <> 'deleted' ${options.includeRetired ? "" : "AND t.retired = 0"}
        AND (? IS NULL OR t.kind = ?) ORDER BY t.last_seen DESC, t.lesson_key LIMIT ?`)
      .all(options.kind ?? null, options.kind ?? null, options.limit ?? -1)
      .map(row => JSON.parse(row.data as string) as ToolLesson);
  }

}
