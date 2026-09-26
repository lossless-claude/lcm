// src/daemon/log.ts
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ScrubEngine } from "../scrub.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogRecord = { ts: string; level: LogLevel; event: string; [field: string]: unknown };
export type LogState = { failing: boolean; dropped: number; since?: string };

/**
 * The daemon's own log: one JSON record per line in `<logsDir>/daemon.log`.
 *
 * `write` never throws. A record below the configured level is dropped. String
 * fields outside the identity allowlist are free-form and scrubbed; when the
 * record names a `cwd` whose project scrubber is not loaded yet, they are
 * omitted instead (`scrub: "pending"`), so a project-only pattern can never be
 * bypassed. A failed append is counted, not retried at once: appends pause for
 * a minute and the first one that lands afterwards is preceded by a `log.gap`.
 */
export interface DaemonLog {
  write(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  /** Loads the project scrubber for `cwd`, so records naming it keep their free-form fields. */
  prepare(cwd: string): Promise<void>;
  state(): LogState;
  /**
   * Appends `daemon.start`, noting how the previous daemon ended. Called once
   * this process is the one serving, so a start that loses the port race never
   * writes a marker into the winner's log.
   */
  start(): void;
  /** Appends `daemon.stop` when `start` ran; later writes are ignored. */
  close(reason: string): void;
}

export const noopDaemonLog: DaemonLog = {
  write: () => {},
  prepare: async () => {},
  state: () => ({ failing: false, dropped: 0 }),
  start: () => {},
  close: () => {},
};

export type DaemonLogOptions = {
  path: string;
  level: string;
  maxSizeMB: number;
  retentionDays: number;
  /** `security.sensitivePatterns`. */
  globalPatterns: string[];
  /** The project directory whose `sensitive-patterns.txt` applies to a `cwd`. */
  projectDirFor: (cwd: string) => string;
  version: string;
  now?: () => Date;
};

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const IDENTITY_FIELDS = new Set(["route", "cwd", "session_id", "prev", "version", "from", "to", "to_provider", "path"]);
const MAX_MESSAGE_CHARS = 2048;
const FAILURE_PAUSE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

type Scrubbing = ScrubEngine | "pending" | "unavailable";

function rotatedFiles(path: string): string[] {
  const prefix = `${basename(path)}.`;
  try {
    return readdirSync(dirname(path)).filter((f) => f.startsWith(prefix)).sort().map((f) => join(dirname(path), f));
  } catch {
    return []; // no log directory yet: nothing rotated
  }
}

/** The file's last line, read from its tail. */
function lastLine(file: string): string | undefined {
  const size = statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, length, size - length); } finally { closeSync(fd); }
  return buf.toString("utf-8").split("\n").filter((l) => l.trim()).pop();
}

/** How the previous daemon ended: its last record is `daemon.stop` ("clean"), anything else ("unclean"), or absent ("none"). */
function previousEnding(path: string): "clean" | "unclean" | "none" {
  for (const file of [path, ...rotatedFiles(path).reverse()]) {
    let line: string | undefined;
    try { line = lastLine(file); } catch { continue; } // missing file: try the next rotation
    if (!line) continue;
    try { return (JSON.parse(line) as LogRecord).event === "daemon.stop" ? "clean" : "unclean"; } catch { return "unclean"; }
  }
  return "none";
}

/** The log file on disk: size-based rotation and age-based pruning of rotations. */
class LogFile {
  private size = -1;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;
  constructor(opts: { path: string; maxBytes: number; retentionMs: number; now: () => Date }) {
    ({ path: this.path, maxBytes: this.maxBytes, retentionMs: this.retentionMs, now: this.now } = opts);
  }

  /** Throws when the append fails; the caller owns failure accounting. */
  append(text: string): void {
    const bytes = Buffer.byteLength(text);
    mkdirSync(dirname(this.path), { recursive: true });
    this.rotateIfFull(bytes);
    appendFileSync(this.path, text);
    this.size += bytes;
  }

  prune(): void {
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const file of rotatedFiles(this.path)) {
      try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { continue; } // vanished or locked: next pass
    }
  }

  private rotateIfFull(bytes: number): void {
    if (this.size < 0) this.size = this.currentSize();
    if (this.size === 0 || this.size + bytes <= this.maxBytes) return;
    renameSync(this.path, `${this.path}.${this.now().toISOString().replace(/[:.]/g, "-")}`);
    this.size = 0;
    this.prune();
  }

  private currentSize(): number {
    try { return statSync(this.path).size; } catch { return 0; } // not created yet
  }
}

/** Global scrubber for records without a `cwd`; per-project scrubbers, loaded asynchronously, for the rest. */
class Scrubbers {
  private global: ScrubEngine | undefined;
  private readonly projects = new Map<string, Scrubbing>();
  private readonly loading = new Map<string, Promise<void>>();
  constructor(private readonly globalPatterns: string[], private readonly projectDirFor: (cwd: string) => string) {}

  for(cwd: unknown): Scrubbing {
    if (typeof cwd !== "string" || !cwd) return this.global ??= new ScrubEngine(this.globalPatterns, []);
    const dir = this.projectDirFor(cwd);
    const known = this.projects.get(dir);
    if (known) return known;
    void this.load(dir);
    return "pending";
  }

  async prepare(cwd: string): Promise<void> {
    await this.load(this.projectDirFor(cwd));
  }

  /** One load per project directory; a second caller awaits the first. */
  private load(dir: string): Promise<void> {
    let pending = this.loading.get(dir);
    if (!pending) {
      this.projects.set(dir, "pending");
      pending = ScrubEngine.forProject(this.globalPatterns, dir).then(
        (engine) => { this.projects.set(dir, engine); },
        () => { this.projects.set(dir, "unavailable"); }, // free-form fields of this project stay omitted
      );
      this.loading.set(dir, pending);
    }
    return pending;
  }
}

type LogEntry = { level: LogLevel; event: string; fields: Record<string, unknown> };

/** One JSONL line. Free-form text goes through `scrubbing`, or is omitted when no scrubber is ready. */
function renderRecord(ts: string, { level, event, fields }: LogEntry, scrubbing: Scrubbing): string {
  const record: Record<string, unknown> = { ts, level, event };
  let omitted = false;
  const freeForm = (text: string): string | undefined => {
    if (typeof scrubbing === "string") { omitted = true; return undefined; }
    return scrubbing.scrub(text.slice(0, MAX_MESSAGE_CHARS));
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = renderField(key, value, freeForm);
  }
  if (omitted) record.scrub = scrubbing;
  return JSON.stringify(record) + "\n";
}

function renderField(key: string, value: unknown, freeForm: (text: string) => string | undefined): unknown {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (key === "err") return describeError(value, freeForm);
  if (typeof value === "string") return IDENTITY_FIELDS.has(key) ? value : freeForm(value);
  return freeForm(JSON.stringify(value));
}

function describeError(value: unknown, freeForm: (text: string) => string | undefined): Record<string, unknown> {
  if (!(value instanceof Error)) return { message: freeForm(String(value)) };
  const code = (value as NodeJS.ErrnoException).code;
  const safeCode = typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? { code } : {};
  return { name: value.name, message: freeForm(value.message), ...safeCode };
}

class FileDaemonLog implements DaemonLog {
  private readonly minLevel: number;
  private readonly file: LogFile;
  private readonly scrubbers: Scrubbers;
  private readonly now: () => Date;
  private dropped = 0;
  private firstFailureAt: string | undefined;
  private pausedUntil = 0;
  private started = false;
  private closed = false;

  constructor(private readonly opts: DaemonLogOptions) {
    this.now = opts.now ?? (() => new Date());
    this.minLevel = LEVELS[opts.level in LEVELS ? (opts.level as LogLevel) : "info"];
    this.file = new LogFile({ path: opts.path, maxBytes: opts.maxSizeMB * BYTES_PER_MB, retentionMs: opts.retentionDays * DAY_MS, now: this.now });
    this.scrubbers = new Scrubbers(opts.globalPatterns, opts.projectDirFor);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.file.prune();
    const fields = { pid: process.pid, version: this.opts.version, prev: previousEnding(this.opts.path) };
    this.emit({ level: "info", event: "daemon.start", fields }, true);
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (this.closed || LEVELS[level] < this.minLevel) return;
    this.emit({ level, event, fields }, false);
  }

  async prepare(cwd: string): Promise<void> {
    try {
      await this.scrubbers.prepare(cwd);
    } catch {
      return; // records naming this cwd keep omitting free-form text
    }
  }

  state(): LogState {
    return { failing: this.dropped > 0, dropped: this.dropped, ...(this.firstFailureAt ? { since: this.firstFailureAt } : {}) };
  }

  close(reason: string): void {
    if (this.closed || !this.started) return;
    // Written at every level: the stop marker is what proves continuity.
    this.emit({ level: "info", event: "daemon.stop", fields: { pid: process.pid, reason, dropped: this.dropped } }, true);
    this.closed = true;
  }

  private render(entry: LogEntry): string {
    return renderRecord(this.now().toISOString(), entry, this.scrubbers.for(entry.fields.cwd));
  }

  /** Renders and appends; a record that cannot be rendered (a circular field) is counted as dropped. */
  private emit(entry: LogEntry, marker: boolean): void {
    let line: string;
    try {
      line = this.render(entry);
    } catch {
      this.dropped++;
      return;
    }
    this.append(line, marker);
  }

  /** A start or stop marker is attempted even while appends are paused: it is what proves continuity. */
  private append(line: string, marker: boolean): void {
    const nowMs = this.now().getTime();
    if (nowMs < this.pausedUntil && !marker) { this.dropped++; return; }
    const gap = this.dropped > 0
      ? this.render({ level: "warn", event: "log.gap", fields: { dropped: this.dropped, from: this.firstFailureAt, to: this.now().toISOString() } })
      : "";
    try {
      this.file.append(gap + line);
      this.dropped = 0;
      this.firstFailureAt = undefined;
    } catch (err) {
      this.recordFailure(nowMs, err);
    }
  }

  private recordFailure(failedAtMs: number, err: unknown): void {
    this.dropped++;
    this.firstFailureAt ??= new Date(failedAtMs).toISOString();
    this.pausedUntil = failedAtMs + FAILURE_PAUSE_MS;
    const code = (err as NodeJS.ErrnoException)?.code ?? "error";
    try {
      process.stderr.write(`[lcm] daemon log write failed (${code}); pausing for 60s\n`);
    } catch { /* stderr gone too: the gap is still counted */ }
  }
}

/** Opens the log; nothing is written until the first record. */
export function openDaemonLog(opts: DaemonLogOptions): DaemonLog {
  return new FileDaemonLog(opts);
}

/** Every record at or above `minLevel` written since `since`, oldest first, across daemon.log and its rotations. */
export function readDaemonLog(path: string, filter: { since: Date; minLevel?: LogLevel }): LogRecord[] {
  const min = LEVELS[filter.minLevel ?? "debug"];
  const since = filter.since.getTime();
  const matches = (r: LogRecord) => Date.parse(r.ts) >= since && LEVELS[r.level] >= min;
  return [...rotatedFiles(path), path].flatMap((file) => readRecords(file, since).filter(matches));
}

function readRecords(file: string, since: number): LogRecord[] {
  let text: string;
  try {
    if (statSync(file).mtimeMs < since) return [];
    text = readFileSync(file, "utf-8");
  } catch {
    return []; // pruned between listing and reading
  }
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as LogRecord); } catch { continue; } // a torn line
  }
  return records;
}
