import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fsMock = vi.hoisted((): {
  readCalls: Array<{ length: number; position: number | null }>;
  zeroAtPosition?: number;
} => ({ readCalls: [] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "read") {
            return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
              fsMock.readCalls.push({ length, position });
              if (position === fsMock.zeroAtPosition) {
                fsMock.zeroAtPosition = undefined;
                return { bytesRead: 0, buffer };
              }
              return target.read(buffer, offset, length, position);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import {
  readCodexTranscriptDelta,
  type CodexTranscriptCursor,
} from "../src/codex-transcript-reader.js";

const dirs: string[] = [];

beforeEach(() => {
  fsMock.readCalls.length = 0;
  fsMock.zeroAtPosition = undefined;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-codex-reader-"));
  dirs.push(dir);
  return dir;
}

function metaLine(id: string, cwd: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id, cwd } });
}

function messageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function writeTranscript(
  dir: string,
  id: string,
  records: string[],
  trailingNewline = true,
): string {
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, [metaLine(id, dir), ...records].join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}

async function readLive(path: string, cursor?: CodexTranscriptCursor) {
  return readCodexTranscriptDelta(path, { cursor, includeTrailingRecord: false });
}

function fingerprintWindowStarts(offset: number): number[] {
  const firstLength = Math.min(offset, 4096);
  const lastLength = Math.min(offset - firstLength, 4096);
  return lastLength > 0 ? [0, offset - lastLength] : [0];
}

describe("readCodexTranscriptDelta", () => {
  it("full-scans once and preserves UTF-8 split across read chunks", async () => {
    const dir = makeDir();
    const id = "utf8-session";
    const meta = metaLine(id, dir);
    const template = messageLine("assistant", "MARKER");
    const marker = template.indexOf("MARKER");
    const before = `${meta}\n${template.slice(0, marker)}`;
    const padding = "x".repeat(64 * 1024 - 1 - Buffer.byteLength(before));
    const record = `${template.slice(0, marker)}${padding}é${template.slice(marker + "MARKER".length)}`;
    const path = writeTranscript(dir, id, [record]);

    const result = await readLive(path);

    expect(result.resumed).toBe(false);
    expect(result.sessionMeta).toEqual({ id, cwd: dir });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.endsWith("é")).toBe(true);
    expect(result.cursor).toMatchObject({
      offset: statSync(path).size,
      messageCount: 1,
      recordBoundary: true,
    });
    expect(result.cursor.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("defers a partial UTF-8 live tail without advancing its cursor", async () => {
    const dir = makeDir();
    const path = writeTranscript(dir, "partial-session", [messageLine("user", "before")]);
    const initial = await readLive(path);
    const tail = Buffer.from(`${messageLine("assistant", "after café")}\n`, "utf8");
    const accented = tail.indexOf(Buffer.from("é", "utf8"));

    appendFileSync(path, tail.subarray(0, accented + 1));
    const partial = await readLive(path, initial.cursor);

    expect(partial.resumed).toBe(true);
    expect(partial.messages).toEqual([]);
    expect(partial.cursor).toEqual(initial.cursor);

    appendFileSync(path, tail.subarray(accented + 1));
    const complete = await readLive(path, partial.cursor);
    expect(complete.messages.map(message => message.content)).toEqual(["after café"]);
    expect(complete.cursor).toMatchObject({
      offset: statSync(path).size,
      messageCount: 2,
      recordBoundary: true,
    });
  });

  it("does not reread the old transcript body on unchanged or appended resumes", async () => {
    const dir = makeDir();
    const path = writeTranscript(dir, "resume-session", [
      messageLine("user", "x".repeat(200_000)),
    ]);
    const initial = await readLive(path);

    fsMock.readCalls.length = 0;
    const unchanged = await readLive(path, initial.cursor);
    expect(unchanged.messages).toEqual([]);
    expect(unchanged.cursor).toEqual(initial.cursor);
    const oldWindowStarts = fingerprintWindowStarts(initial.cursor.offset);
    expect(fsMock.readCalls.every(call => (
      call.position === initial.cursor.offset - 1 ||
      (call.position !== null && oldWindowStarts.includes(call.position))
    ))).toBe(true);
    expect(fsMock.readCalls.reduce((total, call) => total + call.length, 0)).toBeLessThanOrEqual(
      8192 + 1 + 2 * 8192,
    );

    const suffix = `${messageLine("assistant", "only the suffix")}\n`;
    appendFileSync(path, suffix);
    fsMock.readCalls.length = 0;
    const appended = await readLive(path, unchanged.cursor);
    expect(appended.messages.map(message => message.content)).toEqual(["only the suffix"]);
    expect(fsMock.readCalls.some(call => call.position === initial.cursor.offset)).toBe(true);
    const newWindowStarts = fingerprintWindowStarts(appended.cursor.offset);
    const boundedStarts = new Set([...oldWindowStarts, ...newWindowStarts]);
    expect(fsMock.readCalls.every(call => (
      call.position === initial.cursor.offset - 1 ||
      (call.position !== null && boundedStarts.has(call.position)) ||
      (call.position !== null && call.position >= initial.cursor.offset)
    ))).toBe(true);
    expect(fsMock.readCalls.reduce((total, call) => total + call.length, 0)).toBeLessThanOrEqual(
      8192 + 1 + 4 * 8192 + Buffer.byteLength(suffix),
    );
  });

  it("periodically yields to the event loop during a large initial scan", async () => {
    const dir = makeDir();
    const path = writeTranscript(dir, "yield-session", [
      messageLine("user", "x".repeat(1024 * 1024 + 1)),
    ]);
    const immediate = vi.spyOn(globalThis, "setImmediate");

    try {
      const result = await readLive(path);
      expect(result.messages).toHaveLength(1);
      expect(immediate).toHaveBeenCalled();
    } finally {
      immediate.mockRestore();
    }
  });

  it("rejects premature header or body EOF instead of returning a partial cursor", async () => {
    const dir = makeDir();
    const path = writeTranscript(dir, "short-read-session", [
      messageLine("user", "x".repeat(100_000)),
    ]);

    fsMock.zeroAtPosition = 0;
    await expect(readLive(path)).rejects.toThrow("Codex transcript changed while reading");

    fsMock.zeroAtPosition = 64 * 1024;
    await expect(readLive(path)).rejects.toThrow("Codex transcript changed while reading");
  });

  it("falls back to a full scan after inode replacement or truncation", async () => {
    const dir = makeDir();
    const id = "replacement-session";
    const path = writeTranscript(dir, id, [
      messageLine("user", "one"),
      messageLine("assistant", "two"),
    ]);
    const initial = await readLive(path);

    renameSync(path, `${path}.old`);
    writeFileSync(path, `${metaLine(id, dir)}\n${messageLine("user", "replacement")}\n`);
    const replacement = await readLive(path, initial.cursor);
    expect(replacement.resumed).toBe(false);
    expect(replacement.messages.map(message => message.content)).toEqual(["replacement"]);

    const replacementCursor = replacement.cursor;
    writeFileSync(path, `${metaLine(id, dir)}\n${messageLine("user", "short")}\n`);
    const truncated = await readLive(path, replacementCursor);
    expect(truncated.resumed).toBe(false);
    expect(truncated.messages.map(message => message.content)).toEqual(["short"]);
  });

  it("full-scans legacy cursors and same-inode same-length rewrites", async () => {
    const dir = makeDir();
    const id = "rewrite-session";
    const original = messageLine("user", "AAAA");
    const replacement = messageLine("user", "BBBB");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    const path = writeTranscript(dir, id, [original]);
    const initial = await readLive(path);

    const legacy: CodexTranscriptCursor = { ...initial.cursor };
    delete legacy.fingerprint;
    const legacyRecovery = await readLive(path, legacy);
    expect(legacyRecovery.resumed).toBe(false);
    expect(legacyRecovery.messages.map(message => message.content)).toEqual(["AAAA"]);

    const inode = statSync(path).ino;
    writeFileSync(path, `${metaLine(id, dir)}\n${replacement}\n`);
    expect(statSync(path).ino).toBe(inode);
    expect(statSync(path).size).toBe(initial.cursor.offset);

    const rewritten = await readLive(path, initial.cursor);
    expect(rewritten.resumed).toBe(false);
    expect(rewritten.messages.map(message => message.content)).toEqual(["BBBB"]);
    expect(rewritten.cursor.fingerprint).not.toBe(initial.cursor.fingerprint);
  });

  it("rejects malformed completed records without exposing their contents", async () => {
    const dir = makeDir();
    const secret = "private-secret-record";
    const path = writeTranscript(dir, "strict-session", [`{${secret}`], false);

    const live = await readLive(path);
    expect(live.messages).toEqual([]);
    expect(live.cursor.offset).toBe(Buffer.byteLength(`${metaLine("strict-session", dir)}\n`));

    await expect(readCodexTranscriptDelta(path, {
      includeTrailingRecord: true,
    })).rejects.toThrow("Invalid Codex transcript JSONL at byte offset");
    await expect(readCodexTranscriptDelta(path, {
      includeTrailingRecord: true,
    })).rejects.not.toThrow(secret);

    appendFileSync(path, "\n");
    await expect(readLive(path, live.cursor)).rejects.toThrow(
      "Invalid Codex transcript JSONL at byte offset",
    );
  });

  it("rejects invalid UTF-8 in completed and import-final records", async () => {
    const dir = makeDir();
    const id = "invalid-utf8-session";
    const path = join(dir, "rollout.jsonl");
    const prefix = `${metaLine(id, dir)}\n${messageLine("assistant", "MARKER").replace("MARKER", "")}`;
    const closingQuote = prefix.lastIndexOf('"');
    const completed = Buffer.concat([
      Buffer.from(prefix.slice(0, closingQuote), "utf8"),
      Buffer.from([0xc3]),
      Buffer.from(`${prefix.slice(closingQuote)}\n`, "utf8"),
    ]);
    writeFileSync(path, completed);
    const messageOffset = Buffer.byteLength(`${metaLine(id, dir)}\n`);

    await expect(readLive(path)).rejects.toThrow(
      `Invalid Codex transcript UTF-8 at byte offset ${messageOffset}`,
    );

    writeFileSync(path, completed.subarray(0, completed.length - 1));
    await expect(readCodexTranscriptDelta(path, {
      includeTrailingRecord: true,
    })).rejects.toThrow(`Invalid Codex transcript UTF-8 at byte offset ${messageOffset}`);
  });

  it("rejects invalid UTF-8 in a completed metadata record", async () => {
    const dir = makeDir();
    const id = "invalid-metadata-session";
    const path = join(dir, "rollout.jsonl");
    const template = metaLine(id, "MARKER");
    const marker = template.indexOf("MARKER");
    const corruptMeta = Buffer.concat([
      Buffer.from(template.slice(0, marker), "utf8"),
      Buffer.from([0xc3]),
      Buffer.from(`${template.slice(marker + "MARKER".length)}\n`, "utf8"),
      Buffer.from(`${metaLine(id, dir)}\n`, "utf8"),
    ]);
    writeFileSync(path, corruptMeta);

    await expect(readLive(path)).rejects.toThrow(
      "Invalid Codex transcript UTF-8 at byte offset 0",
    );
  });

  it("reuses an unchanged imported non-newline EOF but full-scans after growth", async () => {
    const dir = makeDir();
    const id = "historical-session";
    const path = writeTranscript(dir, id, [messageLine("user", "historical")], false);
    const imported = await readCodexTranscriptDelta(path, { includeTrailingRecord: true });
    expect(imported.cursor).toMatchObject({ messageCount: 1, recordBoundary: false });

    const unchanged = await readLive(path, imported.cursor);
    expect(unchanged).toMatchObject({ resumed: true, messages: [] });
    expect(unchanged.cursor).toEqual(imported.cursor);

    appendFileSync(path, `\n${messageLine("assistant", "new live message")}\n`);
    const grown = await readLive(path, unchanged.cursor);
    expect(grown.resumed).toBe(false);
    expect(grown.messages.map(message => message.content)).toEqual([
      "historical",
      "new live message",
    ]);
    expect(grown.cursor).toMatchObject({ messageCount: 2, recordBoundary: true });
  });

  it("falls back when a claimed newline cursor is not on a record boundary", async () => {
    const dir = makeDir();
    const path = writeTranscript(dir, "boundary-session", [messageLine("user", "whole")]);
    const initial = await readLive(path);
    const invalid = { ...initial.cursor, offset: initial.cursor.offset - 2 };

    const recovered = await readLive(path, invalid);
    expect(recovered.resumed).toBe(false);
    expect(recovered.messages.map(message => message.content)).toEqual(["whole"]);
  });
});
