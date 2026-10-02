// src/daemon/log.ts
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
const IDENTITY_FIELDS = new Set(["route", "cwd", "session_id", "parent_session_id", "prev", "version", "from", "to", "from_provider", "to_provider", "path"]);
const MAX_MESSAGE_CHARS = 2048;
const MAX_IDENTITY_CHARS = 512;
const FAILURE_PAUSE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

type Scrubbing = ScrubEngine | "pending" | "unavailable";

const DEFAULT_MAX_SIZE_MB = 10;
const DEFAULT_RETENTION_DAYS = 7;

/** A malformed `daemon.logLevel` (not a string, or an inherited name such as `toString`) means `info`. */
function levelOrInfo(value: unknown): LogLevel {
  return typeof value === "string" && Object.hasOwn(LEVELS, value) ? (value as LogLevel) : "info";
}

/** A malformed `config.json` number falls back to the default instead of rotating on every append. */
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

/** How the log ends: its last record is `daemon.stop` ("clean"), anything else ("unclean"), or there is none ("none"). */
export function logEnding(path: string): "clean" | "unclean" | "none" {
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
  private rotations = 0;
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
    // The counter keeps two rotations within one millisecond from overwriting each other.
    renameSync(this.path, `${this.path}.${this.now().toISOString().replace(/[:.]/g, "-")}-${++this.rotations}`);
    this.size = 0;
    this.prune();
  }

  private currentSize(): number {
    try { return statSync(this.path).size; } catch { return 0; } // not created yet
  }
}

/** Global scrubber for records without a `cwd`; per-project scrubbers, loaded asynchronously, for the rest. */
class Scrubbers {
  private globalEngine: ScrubEngine | undefined;
  private readonly projects = new Map<string, Scrubbing>();
  private readonly loading = new Map<string, Promise<void>>();
  constructor(private readonly globalPatterns: string[], private readonly projectDirFor: (cwd: string) => string) {}

  /** Gitleaks, built-in and `security.sensitivePatterns`: complete for any record without a project. */
  global(): ScrubEngine {
    return this.globalEngine ??= new ScrubEngine(this.globalPatterns, []);
  }

  for(cwd: unknown): Scrubbing {
    if (typeof cwd !== "string" || !cwd) return this.global();
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

/**
 * The scrubbers one record needs. Identity fields (route, cwd, session_id, …) often come
 * from a request body, so they are scrubbed too, with the global engine, which is always
 * ready; they stay present so a record can be found by project or session.
 */
type Engines = { freeForm: Scrubbing; identity: ScrubEngine };
type Scrub = (text: string) => string | undefined;

/** One JSONL line. Free-form text goes through the project scrubber, or is omitted when it is not ready. */
function renderRecord(ts: string, { level, event, fields }: LogEntry, engines: Engines): string {
  const record: Record<string, unknown> = { ts, level, event };
  let omitted = false;
  const freeForm: Scrub = (text) => {
    if (typeof engines.freeForm === "string") { omitted = true; return undefined; }
    return engines.freeForm.scrub(text.slice(0, MAX_MESSAGE_CHARS));
  };
  const identity: Scrub = (text) => engines.identity.scrub(text.slice(0, MAX_IDENTITY_CHARS));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = renderField(key, value, IDENTITY_FIELDS.has(key) ? identity : freeForm);
  }
  if (omitted) record.scrub = engines.freeForm;
  return JSON.stringify(record) + "\n";
}

function renderField(key: string, value: unknown, scrub: Scrub): unknown {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (key === "err") return describeError(value, scrub);
  if (typeof value === "string") return scrub(value);
  return scrub(JSON.stringify(value));
}

/** Keep only lcm frame locations: headers and function labels can contain error data. */
function sourceStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const modulePath = fileURLToPath(import.meta.url);
  const sourceRoot = dirname(dirname(modulePath));
  const bundled = basename(dirname(modulePath)) === "bundle";
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const frame = /^\s+at (?:.* \()?((?:file:\/\/\/|\/)[^()]+):(\d+):(\d+)\)?$/.exec(line);
    if (!frame) continue;
    const path = frame[1].startsWith("file:") ? fileURLToPath(frame[1]) : frame[1];
    const local = relative(sourceRoot, path);
    if (bundled && path !== modulePath) continue;
    if (!bundled && (isAbsolute(local) || local.startsWith("..") || !/^[\w/.-]+\.[cm]?[jt]s$/.test(local) || local.split("/").includes("node_modules"))) continue;
    frames.push(`    at ${bundled ? `bundle/${basename(path)}` : `src/${local}`}:${frame[2]}:${frame[3]}`);
  }
  return frames.length ? frames.join("\n") : undefined;
}

/** Error text is scrubbed; SQLite messages are omitted because they can contain SQL or captured data. */
function describeError(value: unknown, freeForm: Scrub): Record<string, unknown> {
  if (!(value instanceof Error)) return { message: freeForm(String(value)) };
  const { code, errcode, errstr } = value as NodeJS.ErrnoException & { errcode?: number; errstr?: string };
  const stack = sourceStack(value.stack);
  return {
    name: freeForm(value.name),
    ...(typeof code === "string" && code.startsWith("ERR_SQLITE_") ? {} : { message: freeForm(value.message) }),
    ...(typeof code === "string" || typeof code === "number" ? { code: freeForm(String(code)) } : {}),
    ...(typeof errcode === "number" ? { errcode } : {}),
    ...(typeof errstr === "string" ? { errstr: freeForm(errstr) } : {}),
    ...(stack ? { stack: freeForm(stack) } : {}),
  };
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
    this.minLevel = LEVELS[levelOrInfo(opts.level)];
    const maxSizeMB = positiveOr(opts.maxSizeMB, DEFAULT_MAX_SIZE_MB);
    const retentionDays = positiveOr(opts.retentionDays, DEFAULT_RETENTION_DAYS);
    this.file = new LogFile({ path: opts.path, maxBytes: maxSizeMB * BYTES_PER_MB, retentionMs: retentionDays * DAY_MS, now: this.now });
    this.scrubbers = new Scrubbers(opts.globalPatterns, opts.projectDirFor);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.file.prune();
    const fields = { pid: process.pid, version: this.opts.version, prev: logEnding(this.opts.path) };
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
    const engines = { freeForm: this.scrubbers.for(entry.fields.cwd), identity: this.scrubbers.global() };
    return renderRecord(this.now().toISOString(), entry, engines);
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
    const gap = this.dropped > 0 ? this.renderGap() : "";
    try {
      this.file.append(gap + line);
      this.dropped = 0;
      this.firstFailureAt = undefined;
    } catch (err) {
      this.recordFailure(nowMs, err);
    }
  }

  /** The `log.gap` line, or nothing when it cannot be rendered: the record it precedes is still written. */
  private renderGap(): string {
    try {
      return this.render({ level: "warn", event: "log.gap", fields: { dropped: this.dropped, from: this.firstFailureAt, to: this.now().toISOString() } });
    } catch {
      return "";
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
