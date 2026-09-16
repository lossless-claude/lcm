import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexTranscriptCursor } from "../src/codex-transcript-reader.js";
import {
  transcriptSource,
  TranscriptSourceError,
  type ReadContext,
  type StoredTranscript,
} from "../src/transcript-source.js";

/**
 * Each adapter answers "what does this transcript hold beyond what is stored"
 * from a fixture file and a description of the stored state — no database.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A stored state that mirrors what the adapter's own earlier answer would have written. */
function stored(messages: Array<{ role: string; content: string }>, codexCursor?: CodexTranscriptCursor): StoredTranscript {
  return { storedCount: messages.length, storedMessages: () => messages, codexCursor };
}

describe("Claude transcript source", () => {
  const source = transcriptSource("claude");
  const line = (role: string, text: string) => JSON.stringify({ message: { role, content: text } });
  const ctx = (cwd: string): ReadContext => ({ sessionId: "claude-session", cwd, scrub: (text) => text });

  function fixture(): { cwd: string; path: string } {
    const cwd = tempDir("lcm-claude-source-");
    const path = join(cwd, "session.jsonl");
    writeFileSync(path, `${line("user", "one")}\n${line("assistant", "two")}\n`);
    return { cwd, path };
  }

  it("first read: everything the transcript holds, from the start", async () => {
    const { cwd, path } = fixture();
    const delta = await source.read(path, undefined, ctx(cwd));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages.map((m) => [m.role, m.content])).toEqual([["user", "one"], ["assistant", "two"]]);
    expect(delta.codexCursor).toBeUndefined();
  });

  it("empty delta: a fully stored transcript holds nothing more", async () => {
    const { cwd, path } = fixture();
    const delta = await source.read(path, stored([{ role: "user", content: "one" }, { role: "assistant", content: "two" }]), ctx(cwd));
    expect(delta).toMatchObject({ messages: [], sourceOffset: 2 });
  });

  it("delta after a stored prefix: only what follows the stored count", async () => {
    const { cwd, path } = fixture();
    appendFileSync(path, `${line("user", "three")}\n`);
    const delta = await source.read(path, stored([{ role: "user", content: "one" }, { role: "assistant", content: "two" }]), ctx(cwd));
    expect(delta.sourceOffset).toBe(2);
    expect(delta.messages.map((m) => m.content)).toEqual(["three"]);
  });

  it("locates the caller's transcript when it lies under the project, and none when it does not", () => {
    const { cwd, path } = fixture();
    expect(source.locate({ sessionId: "claude-session", cwd, transcriptPath: path })).toBe(path);
    expect(source.locate({ sessionId: "claude-session", cwd, transcriptPath: join(cwd, "missing.jsonl") })).toBeUndefined();
    const elsewhere = tempDir("lcm-claude-elsewhere-");
    writeFileSync(join(elsewhere, "other.jsonl"), line("user", "x"));
    expect(source.locate({ sessionId: "claude-session", cwd, transcriptPath: join(elsewhere, "other.jsonl") })).toBeUndefined();
  });
});

describe("Codex transcript source", () => {
  const source = transcriptSource("codex");
  const sessionId = "codex-session";
  const record = (role: "user" | "assistant", text: string) => JSON.stringify({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  const ctx = (cwd: string, extra: Partial<ReadContext> = {}): ReadContext => ({ sessionId, cwd, scrub: (text) => text, ...extra });

  function fixture(): { cwd: string; path: string } {
    const cwd = tempDir("lcm-codex-source-");
    const path = join(cwd, "rollout.jsonl");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
    writeFileSync(path, `${meta}\n${record("user", "one")}\n${record("assistant", "two")}\n`);
    return { cwd, path };
  }

  it("first read: everything the transcript holds, with a cursor to persist", async () => {
    const { cwd, path } = fixture();
    const delta = await source.read(path, undefined, ctx(cwd));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(delta.codexCursor).toMatchObject({ messageCount: 2, recordBoundary: true });
  });

  it("empty delta: an unchanged transcript resumes at its cursor and holds nothing more", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const second = await source.read(path, stored(first.messages, first.codexCursor), ctx(cwd));
    expect(second.messages).toEqual([]);
    expect(second.sourceOffset).toBe(2);
    expect(second.codexCursor).toEqual(first.codexCursor);
  });

  it("delta after a stored prefix: resumes from the cursor and reports the offset it skipped", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    appendFileSync(path, `${record("user", "three")}\n`);
    const delta = await source.read(path, stored(first.messages, first.codexCursor), ctx(cwd));
    expect(delta.sourceOffset).toBe(2);
    expect(delta.messages.map((m) => m.content)).toEqual(["three"]);
    expect(delta.codexCursor?.messageCount).toBe(3);
  });

  it("stale cursor: one that does not account for the stored count is discarded for a verified full re-read", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    appendFileSync(path, `${record("user", "three")}\n`);
    // Only one message stored, but the cursor claims two: the cursor is not trusted.
    const delta = await source.read(path, stored(first.messages.slice(0, 1), first.codexCursor), ctx(cwd));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("stale cursor: a re-read whose prefix differs from what is stored is refused", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const rewritten = [{ role: "user", content: "not one" }, { role: "assistant", content: "two" }];
    await expect(source.read(path, stored(rewritten, { ...first.codexCursor!, messageCount: 1 }), ctx(cwd)))
      .rejects.toThrow(TranscriptSourceError);
  });

  it("truncated transcript: a file shorter than the stored history is refused", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
    writeFileSync(path, `${meta}\n${record("user", "one")}\n`);
    await expect(source.read(path, stored(first.messages, first.codexCursor), ctx(cwd)))
      .rejects.toThrow("Codex transcript is shorter than stored history; restore the full transcript before retrying");
  });

  it("compares the stored prefix under the current redaction rules", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const redacted = [{ role: "user", content: "[REDACTED]" }, { role: "assistant", content: "two" }];
    const scrub = (text: string) => text.replace("one", "[REDACTED]");
    // No cursor at all forces the full re-read; the redacted stored prefix still matches.
    const delta = await source.read(path, stored(redacted), ctx(cwd, { scrub }));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages).toHaveLength(2);
  });

  it("refuses a transcript whose metadata names another project or session", async () => {
    const { cwd, path } = fixture();
    const elsewhere = tempDir("lcm-codex-elsewhere-");
    await expect(source.read(path, undefined, ctx(elsewhere)))
      .rejects.toThrow("Codex transcript cwd does not match requested project");
    await expect(source.read(path, undefined, ctx(cwd, { sessionId: "another" })))
      .rejects.toThrow("Codex transcript session id does not match request");
  });

  it("locates only an existing transcript under an allowed base, and refuses loudly otherwise", () => {
    const { cwd, path } = fixture();
    expect(source.locate({ sessionId, cwd, transcriptPath: path })).toBe(path);
    expect(source.locate({ sessionId, cwd })).toBeUndefined();
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(cwd, "missing.jsonl") }))
      .toThrow("Codex transcript is unreadable");
    const elsewhere = tempDir("lcm-codex-outside-");
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(elsewhere, "rollout.jsonl") }))
      .toThrow("Codex transcript path is not allowed");
  });
});

describe("adapter selection", () => {
  it("anything that is not Codex reads Claude Code transcripts", () => {
    expect(transcriptSource(undefined).client).toBe("claude");
    expect(transcriptSource("copilot").client).toBe("claude");
    expect(transcriptSource("codex").client).toBe("codex");
  });
});
