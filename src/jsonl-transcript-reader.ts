/**
 * Format-agnostic incremental reader for append-only JSONL transcripts.
 *
 * A cursor is valid only for the same file identity and a verified record
 * boundary. A bounded fingerprint samples the first and last 4 KiB of the
 * consumed prefix, detecting common same-inode rewrites without hashing the
 * whole transcript on every hook. Unsampled in-place edits remain outside the
 * supported append-only stable-prefix contract.
 *
 * The byte machinery is shared; each client's transcript module supplies its
 * record decoder ({@link JsonlTranscriptFormat}). Codex and OMP adapters live
 * beside their parsers (codex-transcript-reader.ts, omp-transcript-reader.ts).
 */

import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { ParsedMessage } from "./transcript.js";

const READ_CHUNK_BYTES = 64 * 1024;
const METADATA_LIMIT_BYTES = 1024 * 1024;
const YIELD_AFTER_BYTES = 1024 * 1024;
const FINGERPRINT_WINDOW_BYTES = 4096;

/** The client-agnostic resume checkpoint: byte-level, format-blind. */
export interface JsonlTranscriptCursor {
  /** Byte immediately after the last consumed complete record. */
  offset: number;
  /** Total stored messages consumed through `offset`. */
  messageCount: number;
  /** String forms avoid losing precision when identities exceed JS safe integers. */
  device: string;
  inode: string;
  /** Whether `offset` follows a newline; false only for an imported final record. */
  recordBoundary: boolean;
  /** Versioned SHA-256 sample of the consumed prefix. Absent legacy cursors restart. */
  fingerprint?: string;
}

/** The per-format surface the byte reader needs: decode and decode records. */
export interface JsonlTranscriptFormat<M> {
  /** Human-readable format name used verbatim in errors ("Codex", "OMP"). */
  readonly label: string;
  /** Domain separator inside the prefix fingerprint; changing it invalidates every existing cursor. */
  readonly fingerprintVersion: string;
  /** Strict UTF-8 decode of one record's bytes. */
  decodeUtf8(bytes: Uint8Array, byteOffset?: number): string;
  /** Parse one decoded record. Invalid JSON throws; valid non-message records return {}. */
  parseRecord(record: string): { message?: ParsedMessage | ParsedMessage[]; sessionMeta?: M };
}

export interface ReadJsonlTranscriptDeltaOptions {
  cursor?: JsonlTranscriptCursor;
  /** Include and strictly validate a final record without a trailing newline. */
  includeTrailingRecord: boolean;
}

export interface JsonlTranscriptDelta<M> {
  messages: ParsedMessage[];
  cursor: JsonlTranscriptCursor;
  resumed: boolean;
  sessionMeta: M;
}

interface ScanResult {
  messages: ParsedMessage[];
  offset: number;
  recordBoundary: boolean;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readExactlyOneByte(handle: FileHandle, position: number, label: string): Promise<number | undefined> {
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, position);
  if (bytesRead === 0) throw new Error(`${label} transcript changed while reading`);
  return bytesRead === 1 ? byte[0] : undefined;
}

async function readWindow(handle: FileHandle, position: number, length: number, label: string): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(
      bytes,
      consumed,
      length - consumed,
      position + consumed,
    );
    if (bytesRead === 0) throw new Error(`${label} transcript changed while reading`);
    consumed += bytesRead;
  }
  return bytes;
}

async function fingerprintPrefix<M>(handle: FileHandle, offset: number, format: JsonlTranscriptFormat<M>): Promise<string> {
  const firstLength = Math.min(offset, FINGERPRINT_WINDOW_BYTES);
  const remaining = offset - firstLength;
  const lastLength = Math.min(remaining, FINGERPRINT_WINDOW_BYTES);
  const lastOffset = offset - lastLength;
  const [first, last] = await Promise.all([
    readWindow(handle, 0, firstLength, format.label),
    readWindow(handle, lastOffset, lastLength, format.label),
  ]);

  return createHash("sha256")
    .update(`${format.fingerprintVersion}\0offset:${offset}\0first:${firstLength}\0last:${lastLength}\0`)
    .update(first)
    .update(last)
    .digest("hex");
}

async function canResume<M>(
  handle: FileHandle,
  cursor: JsonlTranscriptCursor | undefined,
  size: number,
  device: string,
  inode: string,
  format: JsonlTranscriptFormat<M>,
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
    if (await readExactlyOneByte(handle, cursor.offset - 1, format.label) !== 0x0a) return false;
  }

  return await fingerprintPrefix(handle, cursor.offset, format) === cursor.fingerprint;
}

function decodeRecord<M>(format: JsonlTranscriptFormat<M>, parts: Buffer[], length: number, byteOffset: number): string {
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  return format.decodeUtf8(bytes, byteOffset);
}

function parseCompleteRecord<M>(
  format: JsonlTranscriptFormat<M>,
  record: string,
  byteOffset: number,
): ReturnType<JsonlTranscriptFormat<M>["parseRecord"]> {
  const trimmed = record.trim();
  if (!trimmed) return {};
  try {
    return format.parseRecord(trimmed);
  } catch {
    // Do not include transcript bytes in errors: they may contain user data.
    throw new Error(`Invalid ${format.label} transcript JSONL at byte offset ${byteOffset}`);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function scanRecords<M>(
  handle: FileHandle,
  format: JsonlTranscriptFormat<M>,
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
    if (bytesRead === 0) throw new Error(`${format.label} transcript changed while reading`);

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 0x0a) continue;

      const segment = buffer.subarray(segmentStart, index);
      if (segment.length > 0) {
        pending.push(Buffer.from(segment));
        pendingLength += segment.length;
      }

      const parsed = parseCompleteRecord(format, decodeRecord(format, pending, pendingLength, pendingOffset), pendingOffset);
      const nextOffset = position + index + 1;
      if (Array.isArray(parsed.message)) messages.push(...parsed.message);
      else if (parsed.message) messages.push(parsed.message);

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
    const parsed = parseCompleteRecord(format, decodeRecord(format, pending, pendingLength, pendingOffset), pendingOffset);
    if (Array.isArray(parsed.message)) messages.push(...parsed.message);
    else if (parsed.message) messages.push(parsed.message);
    committedOffset = position;
    recordBoundary = false;
  }

  return { messages, offset: committedOffset, recordBoundary };
}

async function readSessionMeta<M>(handle: FileHandle, format: JsonlTranscriptFormat<M>, snapshotSize: number): Promise<M | undefined> {
  const scanSize = Math.min(snapshotSize, METADATA_LIMIT_BYTES);
  const buffer = Buffer.allocUnsafe(Math.min(8192, Math.max(1, scanSize)));
  const pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingOffset = 0;
  let position = 0;

  const inspect = (): M | undefined => {
    const record = decodeRecord(format, pending, pendingLength, pendingOffset).trim();
    pending.length = 0;
    pendingLength = 0;
    if (!record) return undefined;
    try {
      return format.parseRecord(record).sessionMeta;
    } catch {
      // Metadata lookup preserves the existing best-effort header semantics.
      return undefined;
    }
  };

  while (position < scanSize) {
    const requested = Math.min(buffer.length, scanSize - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error(`${format.label} transcript changed while reading`);

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
  return position === snapshotSize && pendingLength > 0 ? inspect() : undefined;
}

/**
 * Read only the suffix added after a durable cursor.
 *
 * Completed records are strict: malformed JSON rejects with a sanitized byte
 * offset. Live incomplete tails are deferred and do not advance the cursor;
 * historical imports include a valid final record without a newline. Invalid
 * cursors cause a full scan and return `resumed: false`. Session metadata is
 * whatever the format's parser extracts from the bounded header scan; the
 * caller validates it.
 */
export async function readJsonlTranscriptDelta<M>(
  transcriptPath: string,
  format: JsonlTranscriptFormat<M>,
  options: ReadJsonlTranscriptDeltaOptions,
): Promise<JsonlTranscriptDelta<M>> {
  let handle: FileHandle;
  try {
    handle = await open(transcriptPath, "r");
  } catch {
    throw new Error(`${format.label} transcript is unreadable`);
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${format.label} transcript is too large`);
    }
    const snapshotSize = Number(stats.size);
    const device = stats.dev.toString();
    const inode = stats.ino.toString();
    const resumed = await canResume(handle, options.cursor, snapshotSize, device, inode, format);
    const guardOffset = resumed ? options.cursor!.offset : snapshotSize;
    const guardFingerprint = resumed
      ? options.cursor!.fingerprint!
      : await fingerprintPrefix(handle, guardOffset, format);
    const sessionMeta = await readSessionMeta(handle, format, snapshotSize);
    const startOffset = resumed ? options.cursor!.offset : 0;

    const scan = await scanRecords(
      handle,
      format,
      startOffset,
      snapshotSize,
      options.includeTrailingRecord,
      resumed ? options.cursor!.recordBoundary : startOffset === 0,
    );
    const initialMessageCount = resumed ? options.cursor!.messageCount : 0;
    const checkpointBefore = await fingerprintPrefix(handle, scan.offset, format);
    const guardAfter = scan.offset === guardOffset
      ? checkpointBefore
      : await fingerprintPrefix(handle, guardOffset, format);
    if (guardAfter !== guardFingerprint) {
      throw new Error(`${format.label} transcript changed while reading`);
    }
    const fingerprint = scan.offset === guardOffset
      ? checkpointBefore
      : await fingerprintPrefix(handle, scan.offset, format);
    if (fingerprint !== checkpointBefore) {
      throw new Error(`${format.label} transcript changed while reading`);
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
      sessionMeta: sessionMeta ?? ({} as M),
    };
  } finally {
    await handle.close();
  }
}
