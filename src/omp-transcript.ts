/**
 * Parser for Oh My Pi (OMP) session transcript files.
 *
 * OMP stores sessions in ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 * (or the active agent dir: --profile / PI_CODING_AGENT_DIR relocate it).
 * `omp gc --apply` archives a cold session by gzipping it in place, alongside
 * the live files: `<timestamp>_<id>.jsonl.gz`. An archive is a single gzip
 * member, not an append-only file, so it is read in full and once — see
 * `parseOmpArchiveTranscript` and the "archived transcripts are import-only"
 * note on `src/jsonl-transcript-reader.ts`.
 *
 * Each JSONL line is one entry object with a top-level `type`:
 *
 *   { type: "session", version, id, cwd, ... }                                  — header
 *   { type: "message", message: { role: "user"|"assistant"|"toolResult"|..., content } }
 *   { type: "title", ... } | { type: "title_change", ... }                       — titles
 *   { type: "compaction" | "reset_boundary" | "custom" | "custom_message" | ... } — state
 *
 * The physical first line may be a fixed-width 256-byte title slot; it parses
 * like any other non-message record. Entries are appended only at runtime;
 * migrations rewrite the file atomically, which a stale byte cursor detects as
 * an identity change and recovers from with a full scan.
 *
 * Every entry after the header carries `id` and `parentId`: the file is an
 * append-only tree. A rewind or branch switch moves the leaf and the abandoned
 * continuation stays in the file, so memory keeps only the path from the last
 * entry ({@link selectOmpLiveMessages}).
 *
 * The persisted `message.role` is camelCase: `user`, `developer`, `assistant`,
 * `toolResult`. An assistant message carries tool invocations as `toolCall`
 * content blocks; each result is its own `toolResult` message entry.
 */

import { existsSync, lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { ompSessionRoots } from "./daemon/project.js";
import { estimateTokens } from "./transcript.js";
import type { ParsedMessage } from "./transcript.js";

/** Throws on invalid UTF-8; the shared reader sanitizes the byte offset it reports. */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function decodeOmpTranscriptUtf8(bytes: Uint8Array, byteOffset?: number): string {
  try {
    return STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    const at = byteOffset === undefined ? "" : ` at byte offset ${byteOffset}`;
    throw new Error(`Invalid UTF-8 in OMP transcript${at}`);
  }
}

// ---------------------------------------------------------------------------
// Types matching the OMP JSONL entry format
// ---------------------------------------------------------------------------

interface OmpContentBlock {
  type?: string;
  text?: string;
  /** toolCall blocks */
  id?: string;
  name?: string;
}

interface OmpMessage {
  role?: string;
  content?: string | OmpContentBlock[];
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface OmpEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  cwd?: string;
  message?: OmpMessage;
}

export interface OmpSessionMeta {
  id?: string;
  cwd?: string;
}

/** An entry's place in the session tree. */
export interface OmpTreeNode {
  id: string;
  parentId: string | null;
}

export interface ParsedOmpTranscriptRecord {
  message?: ParsedMessage | ParsedMessage[];
  sessionMeta?: OmpSessionMeta;
  /** Every entry with an id has one; state entries are links in the parent chain too. */
  node?: OmpTreeNode;
}

/** Marks a tool result the tool itself reported as failed. */
const TOOL_ERROR_MARKER = "[tool error]";

function extractOmpText(content: string | OmpContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function isToolCallBlock(block: OmpContentBlock): boolean {
  return block.type === "toolCall";
}

/**
 * One OMP entry becomes zero or more stored messages.
 *
 * A call keeps only its name — the arguments are the tool's input, not the
 * session's memory — mirroring the Claude and Codex parsers. A tool result
 * keeps its output; a failure is recorded with the shared searchable marker.
 * `developer` turns re-ingest static instruction files, and `custom_message`
 * entries are extension injections (including this integration's own), so
 * neither is ingested.
 */
function parseOmpMessageEntry(message: OmpMessage): ParsedMessage[] {
  const role = message.role;
  if (role === "user") {
    const content = extractOmpText(message.content);
    if (!content.trim()) return [];
    return [{ role: "user", content, tokenCount: estimateTokens(content) }];
  }

  if (role === "assistant") {
    const messages: ParsedMessage[] = [];
    const content = extractOmpText(message.content);
    if (content.trim()) {
      messages.push({ role: "assistant", content, tokenCount: estimateTokens(content) });
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isToolCallBlock(block)) continue;
        const name = typeof block.name === "string" && block.name ? block.name : "toolCall";
        messages.push({ role: "tool", content: name, tokenCount: estimateTokens(name) });
      }
    }
    return messages;
  }

  if (role === "toolResult") {
    const output = extractOmpText(message.content);
    if (!output.trim()) return [];
    const content = message.isError ? `${TOOL_ERROR_MARKER}\n${output}` : output;
    return [{ role: "tool", content, tokenCount: estimateTokens(content) }];
  }

  return [];
}

/**
 * Decode one syntactically complete OMP JSONL record.
 *
 * Invalid JSON intentionally throws so each caller applies its own error
 * policy. Valid non-message entries (titles, compactions, custom entries,
 * mode changes, …) return an empty result.
 */
export function parseOmpTranscriptRecord(record: string): ParsedOmpTranscriptRecord {
  const value: unknown = JSON.parse(record);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const entry = value as OmpEntry;

  // The header: always the first logical entry, after the fixed-width title
  // slot in current files. The title slot itself parses to an empty result.
  if (entry.type === "session") {
    return {
      sessionMeta: {
        id: typeof entry.id === "string" && entry.id ? entry.id : undefined,
        cwd: typeof entry.cwd === "string" && entry.cwd ? entry.cwd : undefined,
      },
    };
  }

  const parsed: ParsedOmpTranscriptRecord = {};
  if (typeof entry.id === "string" && entry.id) {
    parsed.node = { id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null };
  }
  if (entry.type !== "message" || !entry.message) return parsed;
  const messages = parseOmpMessageEntry(entry.message);
  if (messages.length > 0) parsed.message = messages;
  return parsed;
}

/**
 * The messages on the live path among `records`, in file order.
 *
 * OMP resumes a session from the last entry in the file and walks `parentId`
 * to the root. This walks the same chain from the last entry among `records`
 * and stops where the chain leaves them, so a delta keeps only its entries on
 * the path the user kept; stored history before the delta is not revisited.
 * Entries without an id predate the tree format and are always kept.
 *
 * In a `wholeFile` read the chain can only leave the records at an entry the
 * file does not hold, such as a skipped malformed record; its ancestry is then
 * unknown, so every entry is kept in file order rather than dropping the
 * history before the break.
 */
export function selectOmpLiveMessages(records: readonly ParsedOmpTranscriptRecord[], wholeFile = false): ParsedMessage[] {
  const live = ompLivePath(records, wholeFile);
  const messages: ParsedMessage[] = [];
  for (const { node, message } of records) {
    if (!message || (node && live?.has(node.id) === false)) continue;
    if (Array.isArray(message)) messages.push(...message);
    else messages.push(message);
  }
  return messages;
}

/** The ids on the chain from the last entry; undefined when a whole-file chain breaks. */
function ompLivePath(records: readonly ParsedOmpTranscriptRecord[], wholeFile: boolean): Set<string> | undefined {
  const parents = new Map<string, string | null>();
  let leaf: string | null = null;
  for (const { node } of records) {
    if (!node) continue;
    parents.set(node.id, node.parentId);
    leaf = node.id;
  }

  const live = new Set<string>();
  // A corrupt cyclic chain stops at the first repeat, as OMP's own walk does.
  let id = leaf;
  for (; id !== null && parents.has(id) && !live.has(id); id = parents.get(id) ?? null) {
    live.add(id);
  }
  return wholeFile && id !== null && !parents.has(id) ? undefined : live;
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

/**
 * Parse already-decoded OMP JSONL text into records, in file order. Shared by
 * a live file read (`parseOmpTranscript`) and a fully decompressed archive
 * read (`parseOmpArchiveRecords`) — the byte source differs, the record shape
 * does not. Malformed lines are skipped; each caller then selects the live
 * path from the records it gets back.
 */
function ompRecordsFromText(raw: string, includeTrailingRecord: boolean): ParsedOmpTranscriptRecord[] {
  const records: ParsedOmpTranscriptRecord[] = [];
  const lines = raw.split("\n");
  if (!includeTrailingRecord && !raw.endsWith("\n")) {
    // OMP appends completed entries; a final record without a newline is
    // still being written. Defer it until a later capture sees the newline.
    lines.pop();
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(parseOmpTranscriptRecord(trimmed));
    } catch {
      continue;
    }
  }

  return records;
}

/**
 * Parse an OMP session file into the standard ParsedMessage format.
 *
 * Unreadable files return an empty array and malformed JSON records are
 * skipped. Syntactically valid non-message entries and unsupported message
 * roles are ignored, and so are entries off the live path, unless a skipped
 * malformed record broke that path, which reads the file in order. A valid
 * unterminated final record is included by default for historical imports; set
 * `includeTrailingRecord: false` for a live file.
 */
export function parseOmpTranscript(transcriptPath: string, includeTrailingRecord = true): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  return selectOmpLiveMessages(ompRecordsFromText(raw, includeTrailingRecord), true);
}

/**
 * Decompress an archived OMP transcript (`.jsonl.gz`, a single gzip member)
 * and decode it strictly as UTF-8. Throws on corrupt gzip data or invalid
 * UTF-8; callers treat that the same as an unreadable file.
 */
function decompressOmpArchive(transcriptPath: string): string {
  return decodeOmpTranscriptUtf8(gunzipSync(readFileSync(transcriptPath)));
}

export interface OmpArchiveContents {
  meta: OmpSessionMeta | undefined;
  records: ParsedOmpTranscriptRecord[];
  /** Lazy: a caller that never needs a model backfill never pays for the JSON pass. */
  turnModels: () => Map<string, string>;
}

/**
 * Decompress an archived (`.jsonl.gz`) OMP transcript exactly once and derive
 * its session metadata, records, and tool-call model map from that single
 * decode. `gunzipSync` is the expensive step an ingest read must not repeat
 * per archive; parsing the already-decoded text more than once is cheap by
 * comparison. Used by the ingest read path (`readOmpArchive` in
 * src/transcript-source.ts). Discovery (`findOmpSessionFiles`, via
 * `extractOmpArchiveSessionMeta`) decompresses separately: it runs before a
 * session is selected for import, over every archive in the directory, not
 * just the one(s) an ingest actually reads, so it cannot share this decode.
 * Returns undefined for a missing or corrupt archive.
 */
export function loadOmpArchive(transcriptPath: string): OmpArchiveContents | undefined {
  let raw: string;
  try {
    raw = decompressOmpArchive(transcriptPath);
  } catch {
    return undefined;
  }
  const records = ompRecordsFromText(raw, true);
  return {
    meta: records.find((record) => record.sessionMeta)?.sessionMeta,
    records,
    turnModels: () => extractOmpTurnModelsFromLines(raw),
  };
}

/**
 * Every record in an archived (`.jsonl.gz`) OMP session, in file order — the
 * archived counterpart of a live delta's `records` field
 * (src/jsonl-transcript-reader.ts), for a caller to select the live path from
 * (`selectOmpLiveMessages`) or reconcile against stored history with
 * (`ompMessagesAfterStored` in src/transcript-source.ts). An archive is a
 * single gzip member, not an append-only file: it is always read in full,
 * with no resume checkpoint. The trailing record is always complete —
 * `omp gc --apply` only archives a session once it has stopped writing to it.
 * Unreadable or corrupt archives return an empty array.
 */
export function parseOmpArchiveRecords(transcriptPath: string): ParsedOmpTranscriptRecord[] {
  return loadOmpArchive(transcriptPath)?.records ?? [];
}

/** The live-path messages of an archived (`.jsonl.gz`) OMP session. See `parseOmpArchiveRecords`. */
export function parseOmpArchiveTranscript(transcriptPath: string): ParsedMessage[] {
  return selectOmpLiveMessages(parseOmpArchiveRecords(transcriptPath), true);
}

/** Shared by a live and an archived read: maps each tool-call id to the model on the assistant entry that dispatched it. */
function extractOmpTurnModelsFromLines(raw: string): Map<string, string> {
  const models = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as OmpEntry;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant" || typeof message.model !== "string" || !message.model) continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isToolCallBlock(block) && typeof block.id === "string" && block.id) {
        models.set(block.id, message.model);
      }
    }
  }
  return models;
}

/** Maps each tool-call id to the model recorded on the assistant entry that dispatched it. */
export function extractOmpTurnModels(transcriptPath: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return new Map();
  }
  return extractOmpTurnModelsFromLines(raw);
}

/** Same as `extractOmpTurnModels`, for an archived (`.jsonl.gz`) transcript. */
export function extractOmpArchiveTurnModels(transcriptPath: string): Map<string, string> {
  return loadOmpArchive(transcriptPath)?.turnModels() ?? new Map();
}

// ---------------------------------------------------------------------------
// Session metadata and discovery
// ---------------------------------------------------------------------------

/**
 * Read a bounded header scan of an OMP session file: the first `session`
 * record's id and cwd. The header sits at most one 256-byte title slot into
 * the file, but the bound keeps a malformed file from growing the scan.
 */
export function extractOmpSessionMeta(transcriptPath: string): OmpSessionMeta | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(8192);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (let bytes = 0; bytes < 1024 * 1024;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      bytes += count;
      // StringDecoder keeps a multi-byte sequence split across reads intact.
      pending += count === 0 ? decoder.end() : decoder.write(buffer.subarray(0, count));
      const lines = pending.split("\n");
      pending = count === 0 ? "" : lines.pop() ?? "";
      for (const line of lines) {
        try {
          const meta = parseOmpTranscriptRecord(line).sessionMeta;
          if (meta) return meta;
        } catch { /* skip malformed lines */ }
      }
      if (count === 0) break;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  return undefined;
}

/**
 * Read the first `session` record's id and cwd from an archived (`.jsonl.gz`)
 * transcript. Unlike `extractOmpSessionMeta`, there is no bounded streaming
 * scan: the whole member must be decompressed before any of it is readable.
 */
export function extractOmpArchiveSessionMeta(transcriptPath: string): OmpSessionMeta | undefined {
  let raw: string;
  try {
    raw = decompressOmpArchive(transcriptPath);
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const meta = parseOmpTranscriptRecord(trimmed).sessionMeta;
      if (meta) return meta;
    } catch { /* skip malformed lines */ }
  }
  return undefined;
}

export interface OmpSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
  cwd?: string;
  /** A `.jsonl.gz` archive written by `omp gc --apply`: import-only, no resume checkpoint. */
  archived: boolean;
}

const OMP_ARCHIVE_SUFFIX = ".jsonl.gz";

/**
 * Discover OMP transcript files under a sessions root
 * (`<agentDir>/sessions/<bucket>/*.jsonl` and `*.jsonl.gz`): every bucket
 * directory, flat within it. Symlinks are not followed.
 */
export function findOmpSessionFiles(sessionsDir: string): OmpSessionFile[] {
  const files: OmpSessionFile[] = [];
  let buckets: Dirent[];
  try {
    if (!existsSync(sessionsDir) || lstatSync(sessionsDir).isSymbolicLink()) return files;
    buckets = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    // Discovery is best-effort: an unreadable directory must not abort the walk.
    return files;
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue;
    const bucketDir = join(sessionsDir, bucket.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(bucketDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const archived = entry.name.endsWith(OMP_ARCHIVE_SUFFIX);
      if (!archived && !entry.name.endsWith(".jsonl")) continue;
      try {
        const full = join(bucketDir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        const meta = archived ? extractOmpArchiveSessionMeta(full) : extractOmpSessionMeta(full);
        files.push({
          path: full,
          sessionId: meta?.id ?? basename(entry.name, archived ? OMP_ARCHIVE_SUFFIX : ".jsonl"),
          mtime: st.mtimeMs,
          cwd: meta?.cwd,
          archived,
        });
      } catch {
        // skip unreadable entries
      }
    }
  }

  return files.sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Every sessions directory `findAllOmpTranscripts` scans: the explicit
 * override's alone when `ompDir` is given (the single-root case tests and
 * `import`'s `_ompDir` rely on), otherwise the same roots live capture's
 * `isSafeTranscriptPath` accepts for the `omp` client — the active agent
 * directory (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`) plus every named
 * profile's (`~/.omp/profiles/<name>/agent`). Exported so a caller can report
 * where discovery looked, including when it found nothing.
 */
export function ompDiscoveryRoots(ompDir?: string): string[] {
  return ompDir !== undefined ? [join(ompDir, "sessions")] : ompSessionRoots();
}

/**
 * Collect all OMP transcript files (live and archived) from every root
 * `ompDiscoveryRoots` names. Within one root, a live `.jsonl` always wins
 * over an archived `.jsonl.gz` copy of the same session id — `omp gc --apply`
 * compresses a session in place and normally removes the original, so a
 * surviving live file means OMP (or a later session) is still writing to it
 * — and otherwise the newest file of the same kind wins, a root's own
 * bucket-migration duplicates collapsing to it. Across roots, ids are never
 * merged, so a profile's session cannot silently mask — or be masked by —
 * another profile's copy of the same id.
 */
export function findAllOmpTranscripts(ompDir?: string): OmpSessionFile[] {
  const roots = ompDiscoveryRoots(ompDir);

  const combined: OmpSessionFile[] = [];
  for (const root of roots) {
    const found = findOmpSessionFiles(root);
    // Prefer the latest transcript for an identity within this root only. A
    // live file always wins over an archived copy; otherwise the newest file
    // of the same kind wins, a deterministic tie-breaker for equal
    // modification times.
    const seen = new Map<string, OmpSessionFile>();
    for (const f of found) {
      const existing = seen.get(f.sessionId);
      if (!existing) {
        seen.set(f.sessionId, f);
      } else if (existing.archived && !f.archived) {
        seen.set(f.sessionId, f);
      } else if (f.archived === existing.archived && f.mtime > existing.mtime) {
        seen.set(f.sessionId, f);
      }
    }
    combined.push(...seen.values());
  }

  return combined.sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
