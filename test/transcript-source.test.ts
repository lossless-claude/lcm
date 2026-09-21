import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
function stored(messages: Array<{ role: string; content: string }>, checkpoint?: CodexTranscriptCursor): StoredTranscript {
  return { storedCount: messages.length, storedMessages: async () => messages, checkpoint };
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
    expect(delta.checkpoint).toBeUndefined();
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
    expect(source.locate({ sessionId: "claude-session", cwd, transcriptPath: path })).toBe(realpathSync(path));
    expect(source.locate({ sessionId: "claude-session", cwd, transcriptPath: join(cwd, "missing.jsonl") })).toBeUndefined();
    const elsewhere = tempDir("lcm-claude-elsewhere-");
    writeFileSync(join(elsewhere, "other.jsonl"), line("user", "x"));
    expect(() => source.locate({ sessionId: "claude-session", cwd, transcriptPath: join(elsewhere, "other.jsonl") }))
      .toThrow(TranscriptSourceError);
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
    expect(delta.checkpoint).toMatchObject({ messageCount: 2, recordBoundary: true });
  });

  it("empty delta: an unchanged transcript resumes at its cursor and holds nothing more", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const second = await source.read(path, stored(first.messages, first.checkpoint), ctx(cwd));
    expect(second.messages).toEqual([]);
    expect(second.sourceOffset).toBe(2);
    expect(second.checkpoint).toEqual(first.checkpoint);
  });

  it("delta after a stored prefix: resumes from the cursor and reports the offset it skipped", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    appendFileSync(path, `${record("user", "three")}\n`);
    const delta = await source.read(path, stored(first.messages, first.checkpoint), ctx(cwd));
    expect(delta.sourceOffset).toBe(2);
    expect(delta.messages.map((m) => m.content)).toEqual(["three"]);
    expect(delta.checkpoint?.messageCount).toBe(3);
  });

  it("stale cursor: one that does not account for the stored count is discarded for a verified full re-read", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    appendFileSync(path, `${record("user", "three")}\n`);
    // Only one message stored, but the cursor claims two: the cursor is not trusted.
    const delta = await source.read(path, stored(first.messages.slice(0, 1), first.checkpoint), ctx(cwd));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("stale cursor: a re-read whose prefix differs from what is stored is refused", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const rewritten = [{ role: "user", content: "not one" }, { role: "assistant", content: "two" }];
    await expect(source.read(path, stored(rewritten, { ...(first.checkpoint as CodexTranscriptCursor), messageCount: 1 }), ctx(cwd)))
      .rejects.toThrow(TranscriptSourceError);
  });

  it("truncated transcript: a file shorter than the stored history is refused", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } });
    writeFileSync(path, `${meta}\n${record("user", "one")}\n`);
    await expect(source.read(path, stored(first.messages, first.checkpoint), ctx(cwd)))
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
    expect(source.locate({ sessionId, cwd, transcriptPath: path })).toBe(realpathSync(path));
    expect(source.locate({ sessionId, cwd })).toBeUndefined();
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(cwd, "missing.jsonl") }))
      .toThrow("Codex transcript is unreadable");
    const elsewhere = tempDir("lcm-codex-outside-");
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(elsewhere, "rollout.jsonl") }))
      .toThrow("Codex transcript path is not allowed");
  });
});

describe("OMP transcript source", () => {
  const source = transcriptSource("omp");
  const sessionId = "01a0c127-f3c1-7000-af32-68cf17f6be65";
  const ompMessage = (role: string, text: string) => JSON.stringify({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-09-20T23:30:16.129Z",
    message: { role, content: [{ type: "text", text }] },
  });
  const ctx = (cwd: string, extra: Partial<ReadContext> = {}): ReadContext => ({ sessionId, cwd, scrub: (text) => text, ...extra });

  function fixture(): { cwd: string; path: string } {
    const cwd = tempDir("lcm-omp-source-");
    const path = join(cwd, "2026-09-20T23-30-16-129Z_session.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-20T23:30:16.129Z", cwd });
    writeFileSync(path, `${header}\n${ompMessage("user", "one")}\n${ompMessage("assistant", "two")}\n`);
    return { cwd, path };
  }

  it("first read: everything the transcript holds, with a cursor to persist", async () => {
    const { cwd, path } = fixture();
    const delta = await source.read(path, undefined, ctx(cwd));
    expect(delta.sourceOffset).toBe(0);
    expect(delta.messages.map((m) => m.content)).toEqual(["one", "two"]);
    expect(delta.checkpoint).toMatchObject({ messageCount: 2, recordBoundary: true });
  });

  it("delta after a stored prefix: resumes from the cursor and reports the offset it skipped", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    appendFileSync(path, `${ompMessage("user", "three")}\n`);
    const delta = await source.read(path, stored(first.messages, first.checkpoint), ctx(cwd));
    expect(delta.sourceOffset).toBe(2);
    expect(delta.messages.map((m) => m.content)).toEqual(["three"]);
  });

  it("a full rewrite invalidates the cursor and is refused when the stored prefix no longer matches", async () => {
    const { cwd, path } = fixture();
    const first = await source.read(path, undefined, ctx(cwd));
    const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-20T23:30:16.129Z", cwd });
    writeFileSync(path, `${header}\n${ompMessage("user", "rewritten")}\n`);
    await expect(source.read(path, stored(first.messages, first.checkpoint), ctx(cwd)))
      .rejects.toThrow(TranscriptSourceError);
  });

  it("refuses a transcript whose header names another project or session", async () => {
    const { cwd, path } = fixture();
    const elsewhere = tempDir("lcm-omp-elsewhere-");
    await expect(source.read(path, undefined, ctx(elsewhere)))
      .rejects.toThrow("OMP transcript cwd does not match requested project");
    await expect(source.read(path, undefined, ctx(cwd, { sessionId: "another" })))
      .rejects.toThrow("OMP transcript session id does not match request");
  });

  it("locates only the caller's transcript, and refuses loudly otherwise", () => {
    const { cwd, path } = fixture();
    expect(source.locate({ sessionId, cwd, transcriptPath: path })).toBe(realpathSync(path));
    // Unlike Claude, nothing is derivable from the session id alone.
    expect(source.locate({ sessionId, cwd })).toBeUndefined();
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(cwd, "missing.jsonl") }))
      .toThrow("OMP transcript is unreadable");
    const elsewhere = tempDir("lcm-omp-outside-");
    expect(() => source.locate({ sessionId, cwd, transcriptPath: join(elsewhere, "session.jsonl") }))
      .toThrow("OMP transcript path is not allowed");
  });
});

describe("adapter selection", () => {
  it("anything that is not Codex or OMP reads Claude Code transcripts", () => {
    expect(transcriptSource(undefined).client).toBe("claude");
    expect(transcriptSource("copilot").client).toBe("claude");
    expect(transcriptSource("codex").client).toBe("codex");
    expect(transcriptSource("omp").client).toBe("omp");
  });
});
