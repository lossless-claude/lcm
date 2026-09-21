/**
 * Parser for Oh My Pi (OMP) session transcript files.
 *
 * OMP stores sessions in ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 * (or the active agent dir: --profile / PI_CODING_AGENT_DIR relocate it).
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
 * The persisted `message.role` is camelCase: `user`, `developer`, `assistant`,
 * `toolResult`. An assistant message carries tool invocations as `toolCall`
 * content blocks; each result is its own `toolResult` message entry.
 */

import { existsSync, lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
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
  cwd?: string;
  message?: OmpMessage;
}

export interface OmpSessionMeta {
  id?: string;
  cwd?: string;
}

export interface ParsedOmpTranscriptRecord {
  message?: ParsedMessage | ParsedMessage[];
  sessionMeta?: OmpSessionMeta;
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

  if (entry.type !== "message" || !entry.message) return {};
  const messages = parseOmpMessageEntry(entry.message);
  return messages.length === 0 ? {} : { message: messages };
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

/**
 * Parse an OMP session file into the standard ParsedMessage format.
 *
 * Unreadable files return an empty array and malformed JSON records are
 * skipped. Syntactically valid non-message entries and unsupported message
 * roles are ignored. A valid unterminated final record is included by default
 * for historical imports; set `includeTrailingRecord: false` for a live file.
 */
export function parseOmpTranscript(transcriptPath: string, includeTrailingRecord = true): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const messages: ParsedMessage[] = [];
  const lines = raw.split("\n");
  if (!includeTrailingRecord && !raw.endsWith("\n")) {
    // OMP appends completed entries; a final record without a newline is
    // still being written. Defer it until a later capture sees the newline.
    lines.pop();
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ParsedOmpTranscriptRecord;
    try {
      parsed = parseOmpTranscriptRecord(trimmed);
    } catch {
      continue;
    }
    if (Array.isArray(parsed.message)) messages.push(...parsed.message);
    else if (parsed.message) messages.push(parsed.message);
  }

  return messages;
}

/** Maps each tool-call id to the model recorded on the assistant entry that dispatched it. */
export function extractOmpTurnModels(transcriptPath: string): Map<string, string> {
  const models = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return models;
  }

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

export interface OmpSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
  cwd?: string;
}

/**
 * Discover OMP transcript files under a sessions root
 * (`<agentDir>/sessions/<bucket>/*.jsonl`): every bucket directory, flat
 * within it. Symlinks are not followed.
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
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const full = join(bucketDir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        const meta = extractOmpSessionMeta(full);
        files.push({
          path: full,
          sessionId: meta?.id ?? basename(entry.name, ".jsonl"),
          mtime: st.mtimeMs,
          cwd: meta?.cwd,
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
 * Collect all OMP transcript files from an OMP agent directory
 * (`<agentDir>/sessions/`). Defaults to ~/.omp/agent when ompDir is omitted;
 * PI_CODING_AGENT_DIR overrides the default. Archived (.jsonl.gz) sessions are
 * not discovered.
 */
export function findAllOmpTranscripts(ompDir?: string): OmpSessionFile[] {
  const root = ompDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  const results = findOmpSessionFiles(join(root, "sessions"));

  // Prefer the latest transcript for an identity; order is a deterministic
  // tie-breaker for equal modification times.
  const seen = new Map<string, OmpSessionFile>();
  for (const f of results) {
    const existing = seen.get(f.sessionId);
    if (!existing || f.mtime > existing.mtime) seen.set(f.sessionId, f);
  }

  return [...seen.values()].sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
