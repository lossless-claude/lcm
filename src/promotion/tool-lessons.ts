import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SHELL_TOOLS, type ToolOutcome } from "../tool-calls.js";
import { yieldToEventLoop } from "../daemon/project-queue.js";

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

function shapeFlag(word: string): { name: string; hasValue: boolean } {
  const equals = word.indexOf("=");
  if (equals >= 0) return { name: word.slice(0, equals), hasValue: true };
  if (/^-[a-zA-Z].*[\\/]/.test(word)) return { name: word.slice(0, 2), hasValue: true };
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
      const flag = shapeFlag(word);
      flags.add(flag.name);
      hasValues ||= flag.hasValue;
    } else hasValues = true;
  }
  return [...parts, ...[...flags].sort(), ...(hasValues ? ["<args>"] : [])].join(" ");
}

const CALL_WINDOW = 20;
const BATCH_SIZE = 128;
const ENVIRONMENT_SESSION_THRESHOLD = 3;

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

interface StoredCall {
  row_id: number; session_id: string; message_id: number; name: string;
  input: string | null; outcome: ToolOutcome; block_reason: string | null;
  truncated: number; seen: string;
}
interface PendingFailure { call: StoredCall; shape: string; ordinal: number }

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

class LessonDerivation {
  readonly lessons = new Map<string, ToolLesson>();
  pairCount = 0;
  private readonly environments = new Map<string, ToolLesson>();
  private readonly firstFailures = new Map<string, string>();
  private readonly lastSuccesses = new Map<string, { order: string; seen: string }>();
  private session = "";
  private ordinal = 0;
  private pending: PendingFailure[] = [];
  constructor(private readonly project: string) {}

  add(call: StoredCall): void {
    this.advanceSession(call.session_id);
    if (!SHELL_TOOLS.includes(call.name.replace(/^functions\./, "").toLowerCase())) return;
    if (call.outcome === "blocked" && call.block_reason) this.block(call);
    const shape = call.input === null || call.truncated ? null : commandShape(call.input);
    if (shape === null) return;
    if (call.outcome === "failed" || call.outcome === "blocked") {
      this.environment(shape, call);
      this.pending.push({ call, shape, ordinal: this.ordinal });
    } else if (call.outcome === "succeeded") this.success(shape, call);
  }

  private advanceSession(session: string): void {
    if (session !== this.session) {
      this.session = session; this.ordinal = 0; this.pending = [];
    }
    this.ordinal++;
    this.pending = this.pending.filter(failure => this.ordinal - failure.ordinal <= CALL_WINDOW);
  }

  private success(shape: string, call: StoredCall): void {
    const order = this.order(call);
    if (order > (this.lastSuccesses.get(shape)?.order ?? "")) this.lastSuccesses.set(shape, { order, seen: call.seen });
    for (const failure of this.pending.filter(item => item.shape === shape)) this.pair(failure, call);
    this.pending = this.pending.filter(item => item.shape !== shape);
  }

  async finish(): Promise<ReadonlyMap<string, ToolLesson>> {
    let processed = 0;
    for (const [shape, lesson] of this.environments) {
      if (++processed % BATCH_SIZE === 0) await yieldToEventLoop();
      if (Object.keys(lesson.sessionCounts).length < ENVIRONMENT_SESSION_THRESHOLD) continue;
      this.retireOnSuccess(shape, lesson);
      this.lessons.set(JSON.stringify(["environment-rule", shape]), lesson);
    }
    return this.lessons;
  }

  private retireOnSuccess(shape: string, lesson: ToolLesson): void {
    const success = this.lastSuccesses.get(shape);
    if (!success || success.order <= this.firstFailures.get(shape)!) return;
    lesson.retired = true;
    lesson.lastSeen = lesson.lastSeen > success.seen ? lesson.lastSeen : success.seen;
  }

  private environment(shape: string, call: StoredCall): void {
    const lesson = this.environments.get(shape) ?? { ...newLesson("environment-rule", call, this.project), shape };
    observe(lesson, call);
    this.environments.set(shape, lesson);
    const order = this.order(call);
    if (!this.firstFailures.has(shape) || order < this.firstFailures.get(shape)!) this.firstFailures.set(shape, order);
  }

  private order(call: StoredCall): string {
    return call.seen + String(call.message_id).padStart(16, "0") + String(call.row_id).padStart(16, "0");
  }

  private block(call: StoredCall): void {
    const reason = maskBlockReason(call.block_reason!);
    const key = JSON.stringify(["block-reason", reason]);
    const lesson = this.lessons.get(key) ?? { ...newLesson("block-reason", call, this.project), reason };
    observe(lesson, call);
    this.lessons.set(key, lesson);
  }

  private pair(failure: PendingFailure, success: StoredCall): void {
    this.pairCount++;
    const key = JSON.stringify(["error-fix", failure.shape, failure.call.input, success.input]);
    const lesson = this.lessons.get(key) ?? { ...newLesson("error-fix", failure.call, this.project),
      shape: failure.shape, failedCommand: failure.call.input!, succeededCommand: success.input! };
    observe(lesson, failure.call);
    lesson.lastSeen = lesson.lastSeen > success.seen ? lesson.lastSeen : success.seen;
    this.lessons.set(key, lesson);
  }
}

/** Rebuilds derived snapshots only at promotion boundaries, reading and writing bounded pages. */
export class ToolLessonStore {
  constructor(private readonly db: DatabaseSync) {}

  async refresh(project: string): Promise<number> {
    const derivation = new LessonDerivation(project);
    let session = "", messageId = 0, rowId = 0;
    const page = this.db.prepare(`SELECT t.rowid AS row_id, t.*,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', m.event_at), strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at)) AS seen
      FROM transcript_tool_calls t JOIN messages m ON m.message_id = t.message_id
      WHERE (t.session_id, t.message_id, t.rowid) > (?, ?, ?)
        AND NOT EXISTS (SELECT 1 FROM summarize_workers w WHERE w.session_id = t.session_id)
      ORDER BY t.session_id, t.message_id, t.rowid LIMIT ?`);
    while (true) {
      const calls = page.all(session, messageId, rowId, BATCH_SIZE) as unknown as StoredCall[];
      if (!calls.length) break;
      for (const call of calls) derivation.add(call);
      const last = calls[calls.length - 1];
      session = last.session_id; messageId = last.message_id; rowId = last.row_id;
      await yieldToEventLoop();
    }
    const lessons = await derivation.finish();
    await this.publish(lessons);
    return derivation.pairCount;
  }

  list(options: { limit?: number; includeRetired?: boolean } = {}): ToolLesson[] {
    return this.db.prepare(`SELECT data FROM tool_lessons
      WHERE generation = (SELECT generation FROM tool_lesson_state WHERE singleton = 1)
        ${options.includeRetired ? "" : "AND retired = 0"} ORDER BY last_seen DESC, lesson_key LIMIT ?`)
      .all(options.limit ?? -1)
      .map(row => JSON.parse(row.data as string) as ToolLesson);
  }

  private async publish(lessons: ReadonlyMap<string, ToolLesson>): Promise<void> {
    const generation = Number((this.db.prepare("SELECT MAX(COALESCE((SELECT MAX(generation) FROM tool_lessons), 0), COALESCE((SELECT generation FROM tool_lesson_state WHERE singleton = 1), 0)) + 1 AS next").get()!).next);
    const insert = this.db.prepare("INSERT INTO tool_lessons (generation, lesson_key, kind, retired, last_seen, data) VALUES (?, ?, ?, ?, ?, ?)");
    let written = 0;
    for (const [key, lesson] of lessons) {
      insert.run(generation, key, lesson.kind, Number(lesson.retired), lesson.lastSeen, JSON.stringify(lesson));
      if (++written % BATCH_SIZE === 0) await yieldToEventLoop();
    }
    this.db.prepare("INSERT INTO tool_lesson_state VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation").run(generation);
    const cleanup = this.db.prepare("DELETE FROM tool_lessons WHERE rowid IN (SELECT rowid FROM tool_lessons WHERE generation < ? LIMIT ?)");
    while (cleanup.run(generation, BATCH_SIZE).changes) await yieldToEventLoop();
  }
}
