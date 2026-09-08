/**
 * Incremental asynchronous reader for append-only Codex JSONL transcripts.
 *
 * A cursor is valid only for the same file identity and a verified record
 * boundary. A bounded fingerprint samples the first and last 4 KiB of the
 * consumed prefix, detecting common same-inode rewrites without hashing the
 * whole transcript on every hook. Unsampled in-place edits remain outside the
 * supported append-only stable-prefix contract.
 */

import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { ParsedMessage } from "./transcript.js";
import {
  decodeCodexTranscriptUtf8,
  parseCodexTranscriptRecord,
  type CodexSessionMeta,
} from "./codex-transcript.js";

const READ_CHUNK_BYTES = 64 * 1024;
const METADATA_LIMIT_BYTES = 1024 * 1024;
const YIELD_AFTER_BYTES = 1024 * 1024;
const FINGERPRINT_WINDOW_BYTES = 4096;
const FINGERPRINT_VERSION = "codex-transcript-prefix-v1";

export interface CodexTranscriptCursor {
  /** Byte immediately after the last consumed complete record. */
  offset: number;
  /** Total canonical user/assistant messages consumed through `offset`. */
  messageCount: number;
  /** String forms avoid losing precision when identities exceed JS safe integers. */
  device: string;
  inode: string;
  /** Whether `offset` follows a newline; false only for an imported final record. */
  recordBoundary: boolean;
  /** Versioned SHA-256 sample of the consumed prefix. Absent legacy cursors restart. */
  fingerprint?: string;
}

export interface ReadCodexTranscriptDeltaOptions {
  cursor?: CodexTranscriptCursor;
  /** Include and strictly validate a final record without a trailing newline. */
  includeTrailingRecord: boolean;
}

export interface CodexTranscriptDelta {
  messages: ParsedMessage[];
  cursor: CodexTranscriptCursor;
  resumed: boolean;
  sessionMeta: CodexSessionMeta;
}

interface ScanResult {
  messages: ParsedMessage[];
  offset: number;
  recordBoundary: boolean;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readExactlyOneByte(handle: FileHandle, position: number): Promise<number | undefined> {
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, position);
  if (bytesRead === 0) throw new Error("Codex transcript changed while reading");
  return bytesRead === 1 ? byte[0] : undefined;
}

async function readWindow(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(
      bytes,
      consumed,
      length - consumed,
      position + consumed,
    );
    if (bytesRead === 0) throw new Error("Codex transcript changed while reading");
    consumed += bytesRead;
  }
  return bytes;
}

async function fingerprintPrefix(handle: FileHandle, offset: number): Promise<string> {
  const firstLength = Math.min(offset, FINGERPRINT_WINDOW_BYTES);
  const remaining = offset - firstLength;
  const lastLength = Math.min(remaining, FINGERPRINT_WINDOW_BYTES);
  const lastOffset = offset - lastLength;
  const [first, last] = await Promise.all([
    readWindow(handle, 0, firstLength),
    readWindow(handle, lastOffset, lastLength),
  ]);

  return createHash("sha256")
    .update(`${FINGERPRINT_VERSION}\0offset:${offset}\0first:${firstLength}\0last:${lastLength}\0`)
    .update(first)
    .update(last)
    .digest("hex");
}

async function canResume(
  handle: FileHandle,
  cursor: CodexTranscriptCursor | undefined,
  size: number,
  device: string,
  inode: string,
): Promise<boolean> {
  if (!cursor) return false;
  if (!isNonNegativeInteger(cursor.offset) || !isNonNegativeInteger(cursor.messageCount)) return false;
  if (cursor.device !== device || cursor.inode !== inode || cursor.offset > size) return false;
  if (typeof cursor.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(cursor.fingerprint)) {
    return false;
  }

  if (!cursor.recordBoundary) {
    // Historical imports may consume a valid final record without a newline.
    // It remains resumable only while EOF is unchanged. Growth forces a full
    // scan so bytes appended to that former final record cannot be skipped.
    if (cursor.offset !== size) return false;
  } else if (cursor.offset > 0) {
    if (await readExactlyOneByte(handle, cursor.offset - 1) !== 0x0a) return false;
  }

  return await fingerprintPrefix(handle, cursor.offset) === cursor.fingerprint;
}

function decodeRecord(parts: Buffer[], length: number, byteOffset: number): string {
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  return decodeCodexTranscriptUtf8(bytes, byteOffset);
}

function parseCompleteRecord(record: string, byteOffset: number): ReturnType<typeof parseCodexTranscriptRecord> {
  const trimmed = record.trim();
  if (!trimmed) return {};
  try {
    return parseCodexTranscriptRecord(trimmed);
  } catch {
    // Do not include transcript bytes in errors: they may contain user data.
    throw new Error(`Invalid Codex transcript JSONL at byte offset ${byteOffset}`);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function scanRecords(
  handle: FileHandle,
  startOffset: number,
  snapshotSize: number,
  includeTrailingRecord: boolean,
  initialRecordBoundary: boolean,
): Promise<ScanResult> {
  const messages: ParsedMessage[] = [];
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingOffset = startOffset;
  let position = startOffset;
  let committedOffset = startOffset;
  let recordBoundary = initialRecordBoundary;
  let bytesSinceYield = 0;

  while (position < snapshotSize) {
    const requested = Math.min(buffer.length, snapshotSize - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error("Codex transcript changed while reading");

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 0x0a) continue;

      const segment = buffer.subarray(segmentStart, index);
      if (segment.length > 0) {
        pending.push(Buffer.from(segment));
        pendingLength += segment.length;
      }

      const parsed = parseCompleteRecord(decodeRecord(pending, pendingLength, pendingOffset), pendingOffset);
      const nextOffset = position + index + 1;
      if (parsed.message) messages.push(parsed.message);

      committedOffset = nextOffset;
      pendingOffset = nextOffset;
      recordBoundary = true;
      pending.length = 0;
      pendingLength = 0;
      segmentStart = index + 1;
    }

    const remainder = buffer.subarray(segmentStart, bytesRead);
    if (remainder.length > 0) {
      pending.push(Buffer.from(remainder));
      pendingLength += remainder.length;
    }

    position += bytesRead;
    bytesSinceYield += bytesRead;
    if (bytesSinceYield >= YIELD_AFTER_BYTES) {
      bytesSinceYield = 0;
      await yieldToEventLoop();
    }
  }

  if (pendingLength > 0 && includeTrailingRecord && position === snapshotSize) {
    const parsed = parseCompleteRecord(decodeRecord(pending, pendingLength, pendingOffset), pendingOffset);
    if (parsed.message) messages.push(parsed.message);
    committedOffset = position;
    recordBoundary = false;
  }

  return { messages, offset: committedOffset, recordBoundary };
}

async function readSessionMeta(handle: FileHandle, snapshotSize: number): Promise<CodexSessionMeta> {
  const scanSize = Math.min(snapshotSize, METADATA_LIMIT_BYTES);
  const buffer = Buffer.allocUnsafe(Math.min(8192, Math.max(1, scanSize)));
  const pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingOffset = 0;
  let position = 0;

  const inspect = (): CodexSessionMeta | undefined => {
    const record = decodeRecord(pending, pendingLength, pendingOffset).trim();
    pending.length = 0;
    pendingLength = 0;
    if (!record) return undefined;
    try {
      return parseCodexTranscriptRecord(record).sessionMeta;
    } catch {
      // Metadata lookup preserves the existing best-effort header semantics.
      return undefined;
    }
  };

  while (position < scanSize) {
    const requested = Math.min(buffer.length, scanSize - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error("Codex transcript changed while reading");

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 0x0a) continue;
      const segment = buffer.subarray(segmentStart, index);
      if (segment.length > 0) {
        pending.push(Buffer.from(segment));
        pendingLength += segment.length;
      }
      const meta = inspect();
      if (meta) return meta;
      pendingOffset = position + index + 1;
      segmentStart = index + 1;
    }

    const remainder = buffer.subarray(segmentStart, bytesRead);
    if (remainder.length > 0) {
      pending.push(Buffer.from(remainder));
      pendingLength += remainder.length;
    }
    position += bytesRead;
  }

  // Only an actual EOF makes the remaining bytes a complete historical
  // record. Reaching the metadata scan limit does not.
  return position === snapshotSize && pendingLength > 0 ? inspect() ?? {} : {};
}

/**
 * Read only the suffix added after a durable Codex transcript cursor.
 *
 * Completed records are strict: malformed JSON rejects with a sanitized byte
 * offset. Live incomplete tails are deferred and do not advance the cursor;
 * historical imports include a valid final record without a newline. Invalid
 * cursors cause a full scan and return `resumed: false`.
 */
export async function readCodexTranscriptDelta(
  transcriptPath: string,
  options: ReadCodexTranscriptDeltaOptions,
): Promise<CodexTranscriptDelta> {
  let handle: FileHandle;
  try {
    handle = await open(transcriptPath, "r");
  } catch {
    throw new Error("Codex transcript is unreadable");
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Codex transcript is too large");
    }
    const snapshotSize = Number(stats.size);
    const device = stats.dev.toString();
    const inode = stats.ino.toString();
    const resumed = await canResume(handle, options.cursor, snapshotSize, device, inode);
    const guardOffset = resumed ? options.cursor!.offset : snapshotSize;
    const guardFingerprint = resumed
      ? options.cursor!.fingerprint!
      : await fingerprintPrefix(handle, guardOffset);
    const sessionMeta = await readSessionMeta(handle, snapshotSize);
    if (!sessionMeta.cwd) throw new Error("Codex transcript metadata is missing a cwd");
    const startOffset = resumed ? options.cursor!.offset : 0;

    const scan = await scanRecords(
      handle,
      startOffset,
      snapshotSize,
      options.includeTrailingRecord,
      resumed ? options.cursor!.recordBoundary : startOffset === 0,
    );
    const initialMessageCount = resumed ? options.cursor!.messageCount : 0;
    const checkpointBefore = await fingerprintPrefix(handle, scan.offset);
    const guardAfter = scan.offset === guardOffset
      ? checkpointBefore
      : await fingerprintPrefix(handle, guardOffset);
    if (guardAfter !== guardFingerprint) {
      throw new Error("Codex transcript changed while reading");
    }
    const fingerprint = scan.offset === guardOffset
      ? checkpointBefore
      : await fingerprintPrefix(handle, scan.offset);
    if (fingerprint !== checkpointBefore) {
      throw new Error("Codex transcript changed while reading");
    }

    return {
      messages: scan.messages,
      cursor: {
        offset: scan.offset,
        messageCount: initialMessageCount + scan.messages.length,
        device,
        inode,
        recordBoundary: scan.recordBoundary,
        fingerprint,
      },
      resumed,
      sessionMeta,
    };
  } finally {
    await handle.close();
  }
}
