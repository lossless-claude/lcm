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
 * record decoder ({@link JsonlTranscriptFormat}). Claude, Codex and OMP adapters
 * live beside their parsers (*-transcript-reader.ts).
 */

import { createHash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { ParsedMessage } from "./transcript.js";

const READ_CHUNK_BYTES = 64 * 1024;
const METADATA_LIMIT_BYTES = 1024 * 1024;
const YIELD_AFTER_BYTES = 1024 * 1024;
const FINGERPRINT_WINDOW_BYTES = 4096;
/** Limit transient UUID proofs while the caller owns a mutation lease. */
export const MAX_BOUNDARY_SCAN_BYTES = 1024 * 1024;

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

/** One decoded record: the messages it contributes and any session metadata it carries. */
export interface JsonlTranscriptRecord<M> {
  message?: ParsedMessage | ParsedMessage[];
  sessionMeta?: M;
}

/** The per-format surface the byte reader needs: decode and decode records. */
export interface JsonlTranscriptFormat<M, R extends JsonlTranscriptRecord<M> = JsonlTranscriptRecord<M>> {
  /** Human-readable format name used verbatim in errors ("Claude", "Codex", "OMP"). */
  readonly label: string;
  /** Domain separator inside the prefix fingerprint; changing it invalidates every existing cursor. */
  readonly fingerprintVersion: string;
  /** False for a format without a session header; avoids a redundant bounded header scan. */
  readonly hasSessionMeta?: boolean;
  /** Strict UTF-8 decode of one record's bytes. */
  decodeUtf8(bytes: Uint8Array, byteOffset?: number): string;
  /** Parse one decoded record. Invalid JSON throws; valid non-message records return no message. */
  parseRecord(record: string): R;
  /** Best-effort formats can defer an incomplete historical EOF instead of consuming it. */
  isCompleteTrailingRecord?(record: string): boolean;
  /**
   * Chooses the messages a delta keeps from every record it read, in file order.
   * Absent, each record's messages are kept as read.
   */
  selectMessages?(records: readonly R[]): ParsedMessage[];
}

export interface ReadJsonlTranscriptDeltaOptions {
  cursor?: JsonlTranscriptCursor;
  /** Include and strictly validate a final record without a trailing newline. */
  includeTrailingRecord: boolean;
  /** Optional transient boundary proof, including records behind a resumed cursor. */
  recordMatches?: (record: string) => boolean;
  signal?: AbortSignal;
}

export interface JsonlTranscriptDelta<M, R = JsonlTranscriptRecord<M>> {
  messages: ParsedMessage[];
  cursor: JsonlTranscriptCursor;
  resumed: boolean;
  complete: boolean;
  recordMatched?: boolean;
  boundaryScanExceeded?: boolean;
  sessionMeta: M;
  /** The delta's records in file order; present only for a format that selects its messages. */
  records?: R[];
}

interface ScanResult<R> {
  messages: ParsedMessage[];
  records?: R[];
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

async function fingerprintPrefix<M, R extends JsonlTranscriptRecord<M>>(handle: FileHandle, offset: number, format: JsonlTranscriptFormat<M, R>): Promise<string> {
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

async function canResume<M, R extends JsonlTranscriptRecord<M>>(
  handle: FileHandle,
  cursor: JsonlTranscriptCursor | undefined,
  size: number,
  device: string,
  inode: string,
  format: JsonlTranscriptFormat<M, R>,
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

function decodeRecord<M, R extends JsonlTranscriptRecord<M>>(format: JsonlTranscriptFormat<M, R>, parts: Buffer[], length: number, byteOffset: number): string {
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  return format.decodeUtf8(bytes, byteOffset);
}

function parseCompleteRecord<M, R extends JsonlTranscriptRecord<M>>(
  format: JsonlTranscriptFormat<M, R>,
  record: string,
  byteOffset: number,
): R | undefined {
  const trimmed = record.trim();
  if (!trimmed) return undefined;
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

async function findBoundaryInTail(
  handle: FileHandle, offset: number, label: string,
  matches: (record: string) => boolean, signal?: AbortSignal,
): Promise<{ matched: boolean; exceeded: boolean }> {
  const length = Math.min(offset, MAX_BOUNDARY_SCAN_BYTES);
  const start = offset - length;
  const lines = (await readWindow(handle, start, length, label)).toString("utf8").split("\n");
  // The first fragment may start inside a record or a UTF-8 code point.
  if (start > 0) lines.shift();
  for (const line of lines) {
    signal?.throwIfAborted();
    if (line.trim() && matches(line.trim())) return { matched: true, exceeded: false };
  }
  return { matched: false, exceeded: start > 0 };
}

async function scanRecords<M, R extends JsonlTranscriptRecord<M>>(
  handle: FileHandle,
  format: JsonlTranscriptFormat<M, R>,
  startOffset: number,
  snapshotSize: number,
  includeTrailingRecord: boolean,
  initialRecordBoundary: boolean,
  signal?: AbortSignal,
): Promise<ScanResult<R>> {
  const messages: ParsedMessage[] = [];
  const records: R[] = [];
  const take = (parsed: R | undefined): void => {
    if (!parsed) return;
    if (format.selectMessages) records.push(parsed);
    else if (Array.isArray(parsed.message)) messages.push(...parsed.message);
    else if (parsed.message) messages.push(parsed.message);
  };
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingOffset = startOffset;
  let position = startOffset;
  let committedOffset = startOffset;
  let recordBoundary = initialRecordBoundary;
  let bytesSinceYield = 0;

  while (position < snapshotSize) {
    signal?.throwIfAborted();
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

      signal?.throwIfAborted();
      take(parseCompleteRecord(format, decodeRecord(format, pending, pendingLength, pendingOffset), pendingOffset));
      const nextOffset = position + index + 1;

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
    const record = decodeRecord(format, pending, pendingLength, pendingOffset);
    if (!format.isCompleteTrailingRecord || format.isCompleteTrailingRecord(record)) {
      take(parseCompleteRecord(format, record, pendingOffset));
      committedOffset = position;
      recordBoundary = false;
    }
  }

  if (!format.selectMessages) return { messages, offset: committedOffset, recordBoundary };
  return { messages: format.selectMessages(records), records, offset: committedOffset, recordBoundary };
}

async function readSessionMeta<M, R extends JsonlTranscriptRecord<M>>(handle: FileHandle, format: JsonlTranscriptFormat<M, R>, snapshotSize: number): Promise<M | undefined> {
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
 * Formats decide whether malformed completed records are ignored or reject with
 * a sanitized byte offset. Live incomplete tails do not advance the cursor;
 * historical imports include a valid final record without a newline. Invalid
 * cursors cause a full scan and return `resumed: false`. Session metadata is
 * whatever the format's parser extracts from the bounded header scan; the
 * caller validates it.
 */
export async function readJsonlTranscriptDelta<M, R extends JsonlTranscriptRecord<M> = JsonlTranscriptRecord<M>>(
  transcriptPath: string,
  format: JsonlTranscriptFormat<M, R>,
  options: ReadJsonlTranscriptDeltaOptions,
): Promise<JsonlTranscriptDelta<M, R>> {
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
    const sessionMeta = format.hasSessionMeta === false ? undefined : await readSessionMeta(handle, format, snapshotSize);
    const startOffset = resumed ? options.cursor!.offset : 0;

    let recordMatched = false;
    let boundaryScanExceeded = false;
    options.signal?.throwIfAborted();
    const checkedFormat = options.recordMatches ? { ...format, parseRecord: (record: string) => {
      recordMatched ||= options.recordMatches!(record);
      return format.parseRecord(record);
    } } : format;
    const scan = await scanRecords(
      handle,
      checkedFormat,
      startOffset,
      snapshotSize,
      options.includeTrailingRecord,
      resumed ? options.cursor!.recordBoundary : startOffset === 0,
      options.signal,
    );
    options.signal?.throwIfAborted();
    if (options.recordMatches && !recordMatched && startOffset > 0) {
      const boundary = await findBoundaryInTail(handle, startOffset, format.label, options.recordMatches, options.signal);
      recordMatched = boundary.matched;
      boundaryScanExceeded = boundary.exceeded;
    }
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
      records: scan.records,
      cursor: {
        offset: scan.offset,
        messageCount: initialMessageCount + scan.messages.length,
        device,
        inode,
        recordBoundary: scan.recordBoundary,
        fingerprint,
      },
      resumed,
      complete: scan.offset === snapshotSize && (!options.recordMatches || await stat(transcriptPath, { bigint: true })
        .then(now => now.size === stats.size && now.dev === stats.dev && now.ino === stats.ino, () => false)),
      ...(options.recordMatches ? { recordMatched, boundaryScanExceeded } : {}),
      sessionMeta: sessionMeta ?? ({} as M),
    };
  } finally {
    await handle.close();
  }
}
