import type { DatabaseSync } from "node:sqlite";
import { yieldToEventLoop } from "../daemon/project-queue.js";
import type { StoredCall, ToolLesson } from "./tool-lessons.js";

export const BATCH_SIZE = 128;
const ENVIRONMENT_SESSION_THRESHOLD = 3;

function callOrder(call: StoredCall): string {
  return call.seen + String(call.message_id).padStart(16, "0") + String(call.row_id).padStart(16, "0");
}

export function lessonKey(lesson: ToolLesson): string {
  return JSON.stringify(lesson.kind === "error-fix"
    ? [lesson.kind, lesson.shape, lesson.failedCommand, lesson.succeededCommand]
    : [lesson.kind, lesson.shape ?? lesson.reason]);
}

interface Contribution {
  call_row: number; kind: ToolLesson["kind"]; lesson_key: string; session_id: string; data: string;
}

export function withLessonTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("SAVEPOINT tool_lesson_update");
  try { work(); db.exec("RELEASE tool_lesson_update"); }
  catch (error) {
    db.exec("ROLLBACK TO tool_lesson_update; RELEASE tool_lesson_update");
    throw error;
  }
}

/** Maintains counts and immutable published versions without copying unchanged lessons. */
export class ToolLessonProjection {
  constructor(private readonly db: DatabaseSync) {}

  replaceContribution(row: number, kind: ToolLesson["kind"], evidence?: { call: StoredCall; lesson?: ToolLesson }): void {
    const call = evidence?.call, lesson = evidence?.lesson;
    const old = this.db.prepare("SELECT * FROM tool_lesson_contributions WHERE call_row = ? AND kind = ?")
      .get(row, kind) as unknown as Contribution | undefined;
    const data = lesson && JSON.stringify(lesson);
    if (old?.data === data) return;
    if (old) {
      this.db.prepare("DELETE FROM tool_lesson_contributions WHERE call_row = ? AND kind = ?").run(row, kind);
      this.adjustTotal(old.lesson_key, { lesson: JSON.parse(old.data) as ToolLesson, session: old.session_id }, -1);
    }
    if (lesson && call) {
      const key = lessonKey(lesson);
      this.db.prepare("INSERT INTO tool_lesson_contributions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row, kind, key, call.session_id, lesson.firstSeen, lesson.lastSeen, callOrder(call), data!);
      this.adjustTotal(key, { lesson, session: call.session_id }, 1);
    }
  }

  private adjustTotal(key: string, evidence: { lesson: ToolLesson; session: string }, delta: number): void {
    const { lesson, session } = evidence;
    const row = this.db.prepare("SELECT data FROM tool_lesson_totals WHERE lesson_key = ?").get(key) as { data: string } | undefined;
    const total = row ? JSON.parse(row.data) as ToolLesson : { ...lesson, count: 0, sessionCounts: Object.create(null) as Record<string, number> };
    total.count += delta;
    // JSON may contain session names such as "__proto__"; treat them as own keys.
    const count = (Object.hasOwn(total.sessionCounts, session) ? total.sessionCounts[session] : 0) + delta;
    if (count) Object.defineProperty(total.sessionCounts, session, { value: count, enumerable: true, writable: true, configurable: true });
    else delete total.sessionCounts[session];
    this.db.prepare(`INSERT INTO tool_lesson_totals (lesson_key, data) VALUES (?, ?)
      ON CONFLICT(lesson_key) DO UPDATE SET data = excluded.data, dirty = 1`).run(key, JSON.stringify(total));
    if (lesson.kind === "error-fix") this.db.prepare("UPDATE tool_lesson_progress SET pair_count = pair_count + ? WHERE singleton = 1").run(delta);
  }

  private dirtyEnvironment(shape: string): void {
    this.db.prepare("UPDATE tool_lesson_totals SET dirty = 1 WHERE lesson_key = ?")
      .run(JSON.stringify(["environment-rule", shape]));
  }

  removeSuccess(row: number): void {
    const old = this.db.prepare("SELECT shape FROM tool_lesson_successes WHERE call_row = ?").get(row) as { shape: string } | undefined;
    if (!old) return;
    this.db.prepare("DELETE FROM tool_lesson_successes WHERE call_row = ?").run(row);
    this.dirtyEnvironment(old.shape);
  }

  recordSuccess(call: StoredCall, shape: string): void {
    this.db.prepare("INSERT INTO tool_lesson_successes VALUES (?, ?, ?, ?, ?)")
      .run(call.row_id, call.session_id, shape, callOrder(call), call.seen);
    this.dirtyEnvironment(shape);
  }

  private aggregate(key: string, data: string): ToolLesson | null {
    const lesson = JSON.parse(data) as ToolLesson;
    if (!lesson.count || (lesson.kind === "environment-rule" && Object.keys(lesson.sessionCounts).length < ENVIRONMENT_SESSION_THRESHOLD)) return null;
    lesson.firstSeen = String(this.db.prepare("SELECT first_seen FROM tool_lesson_contributions WHERE lesson_key = ? ORDER BY first_seen LIMIT 1").get(key)!.first_seen);
    lesson.lastSeen = String(this.db.prepare("SELECT last_seen FROM tool_lesson_contributions WHERE lesson_key = ? ORDER BY last_seen DESC LIMIT 1").get(key)!.last_seen);
    lesson.retired = false;
    if (lesson.kind === "environment-rule") this.retireEnvironment(key, lesson);
    return lesson;
  }

  private retireEnvironment(key: string, lesson: ToolLesson): void {
    const first = this.db.prepare("SELECT call_order FROM tool_lesson_contributions WHERE lesson_key = ? ORDER BY call_order LIMIT 1").get(key)!;
    const success = this.db.prepare("SELECT call_order, seen FROM tool_lesson_successes WHERE shape = ? ORDER BY call_order DESC LIMIT 1").get(lesson.shape!) as { call_order: string; seen: string } | undefined;
    if (!success || success.call_order <= String(first.call_order)) return;
    lesson.retired = true;
    lesson.lastSeen = lesson.lastSeen > success.seen ? lesson.lastSeen : success.seen;
  }

  async publish(generation: number): Promise<void> {
    // Changed keys get a new version; unchanged keys retain their published
    // version, so publication never copies the project's snapshot.
    const page = this.db.prepare("SELECT lesson_key, data FROM tool_lesson_totals WHERE dirty = 1 AND lesson_key > ? ORDER BY lesson_key LIMIT ?");
    const insert = this.db.prepare("INSERT OR REPLACE INTO tool_lessons (generation, lesson_key, kind, retired, last_seen, data) VALUES (?, ?, ?, ?, ?, ?)");
    let cursor = "";
    while (true) {
      const rows = page.all(cursor, BATCH_SIZE) as { lesson_key: string; data: string }[];
      if (!rows.length) break;
      withLessonTransaction(this.db, () => {
        for (const row of rows) {
          const lesson = this.aggregate(row.lesson_key, row.data);
          insert.run(generation, row.lesson_key, lesson?.kind ?? "deleted", Number(lesson?.retired ?? true), lesson?.lastSeen ?? "", JSON.stringify(lesson));
        }
      });
      cursor = rows[rows.length - 1].lesson_key;
      await yieldToEventLoop();
    }
    withLessonTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO tool_lesson_state (singleton, generation) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`).run(generation);
      this.db.prepare("UPDATE tool_lesson_progress SET pending = 0 WHERE singleton = 1").run();
    });
    // Prune only changed keys. Dirty markers make an interrupted prune resumable.
    cursor = "";
    while (true) {
      const rows = page.all(cursor, BATCH_SIZE) as { lesson_key: string; data: string }[];
      if (!rows.length) break;
      withLessonTransaction(this.db, () => {
        for (const row of rows) {
          this.db.prepare("DELETE FROM tool_lessons WHERE lesson_key = ? AND generation < ?").run(row.lesson_key, generation);
          this.db.prepare("DELETE FROM tool_lessons WHERE lesson_key = ? AND generation = ? AND kind = 'deleted'").run(row.lesson_key, generation);
          this.db.prepare("UPDATE tool_lesson_totals SET dirty = 0 WHERE lesson_key = ?").run(row.lesson_key);
          this.db.prepare("DELETE FROM tool_lesson_totals WHERE lesson_key = ? AND json_extract(data, '$.count') = 0").run(row.lesson_key);
        }
      });
      cursor = rows[rows.length - 1].lesson_key;
      await yieldToEventLoop();
    }
  }
}
