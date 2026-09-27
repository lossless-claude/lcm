import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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

  describe("an append-only tree: new captures follow the path from the last entry", () => {
    /** `[id, parentId]`: an entry's place in the tree. */
    type At = [string, string | null];
    const timestamp = "2026-09-20T23:30:16.129Z";
    const say = ([id, parentId]: At, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] } });
    const rewindTo = ([id, parentId]: At) => JSON.stringify({ type: "branch_summary", id, parentId, timestamp, fromId: "a2", summary: "" });
    const trunk = [say(["u1", null], "user", "first question"), say(["a1", "u1"], "assistant", "first answer")];
    const wrongTurn = [say(["u2", "a1"], "user", "wrong turn"), say(["a2", "u2"], "assistant", "wrong answer")];
    const betterTurn = [rewindTo(["b1", "a1"]), say(["u3", "b1"], "user", "better question"), say(["a3", "u3"], "assistant", "better answer")];
    const as = (role: string, content: string) => ({ role, content });

    function treeFixture(lines: string[]): { cwd: string; path: string } {
      const { cwd, path } = fixture();
      const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd });
      writeFileSync(path, `${[header, ...lines].join("\n")}\n`);
      return { cwd, path };
    }
    const append = (path: string, lines: string[]) => appendFileSync(path, `${lines.join("\n")}\n`);
    const contents = (delta: { messages: Array<{ content: string }> }) => delta.messages.map((m) => m.content);

    it("a rewind into the stored prefix resumes from the cursor and adds only the live continuation", async () => {
      const { cwd, path } = treeFixture([...trunk, ...wrongTurn]);
      const first = await source.read(path, undefined, ctx(cwd));
      append(path, betterTurn);
      const delta = await source.read(path, stored(first.messages, first.checkpoint), ctx(cwd));
      expect(delta.sourceOffset).toBe(4);
      expect(contents(delta)).toEqual(["better question", "better answer"]);
      expect(delta.checkpoint).toMatchObject({ messageCount: 6 });
    });

    it("a turn abandoned before it was captured is never stored", async () => {
      const { cwd, path } = treeFixture(trunk);
      const first = await source.read(path, undefined, ctx(cwd));
      append(path, [...wrongTurn, ...betterTurn]);
      const delta = await source.read(path, stored(first.messages, first.checkpoint), ctx(cwd));
      expect(delta.sourceOffset).toBe(2);
      expect(contents(delta)).toEqual(["better question", "better answer"]);
      expect(delta.checkpoint).toMatchObject({ messageCount: 4 });
    });

    it("a recovery scan keeps stored turns a rewind abandoned and adds only the live continuation", async () => {
      const { cwd, path } = treeFixture([...trunk, ...wrongTurn, ...betterTurn]);
      const storedInFileOrder = [
        as("user", "first question"), as("assistant", "first answer"), as("user", "wrong turn"), as("assistant", "wrong answer"),
      ];
      const delta = await source.read(path, stored(storedInFileOrder), ctx(cwd));
      expect(delta.sourceOffset).toBe(4);
      expect(contents(delta)).toEqual(["better question", "better answer"]);
      expect(delta.checkpoint).toMatchObject({ messageCount: 6 });

      const nothingNew = await source.read(path, stored([...storedInFileOrder, ...delta.messages]), ctx(cwd));
      expect(contents(nothingNew)).toEqual([]);
      expect(nothingNew.checkpoint).toMatchObject({ messageCount: 6 });
    });

    it("a recovery scan accepts stored history that skipped an abandoned turn", async () => {
      const { cwd, path } = treeFixture([...trunk, ...wrongTurn, ...betterTurn, say(["u4", "a3"], "user", "next question")]);
      const liveOnly = [
        as("user", "first question"), as("assistant", "first answer"), as("user", "better question"), as("assistant", "better answer"),
      ];
      const delta = await source.read(path, stored(liveOnly), ctx(cwd));
      expect(delta.sourceOffset).toBe(4);
      expect(contents(delta)).toEqual(["next question"]);
      expect(delta.checkpoint).toMatchObject({ messageCount: 5 });
    });

    it("a recovery scan does not match stored history to a repeat on an abandoned branch", async () => {
      const { cwd, path } = treeFixture([
        say(["r1", null], "user", "root"),
        say(["y1", "r1"], "assistant", "yes"),
        JSON.stringify({ type: "branch_summary", id: "b1", parentId: "r1", timestamp, fromId: "y1", summary: "" }),
        say(["y2", "b1"], "assistant", "yes"),
      ]);
      const liveOnly = [as("user", "root"), as("assistant", "yes")];
      const delta = await source.read(path, stored(liveOnly), ctx(cwd));
      expect(delta.sourceOffset).toBe(2);
      expect(contents(delta)).toEqual([]);
      expect(delta.checkpoint).toMatchObject({ messageCount: 2 });
    });

    it("a recovery scan refuses stored history the file does not hold in order", async () => {
      const { cwd, path } = treeFixture([...trunk, ...wrongTurn]);
      await expect(source.read(path, stored([as("assistant", "first answer"), as("user", "first question")]), ctx(cwd)))
        .rejects.toThrow(TranscriptSourceError);
    });
  });

  describe("an archived (.jsonl.gz) transcript", () => {
    function archiveFixture(): { cwd: string; path: string } {
      const cwd = tempDir("lcm-omp-archive-source-");
      const path = join(cwd, "2026-08-01T00-00-00-000Z_session.jsonl.gz");
      const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-01T00:00:00.000Z", cwd });
      writeFileSync(path, gzipSync(`${header}\n${ompMessage("user", "one")}\n${ompMessage("assistant", "two")}\n`));
      return { cwd, path };
    }

    it("reads every message with no resume checkpoint", async () => {
      const { cwd, path } = archiveFixture();
      const delta = await source.read(path, undefined, ctx(cwd));
      expect(delta.sourceOffset).toBe(0);
      expect(delta.messages.map((m) => m.content)).toEqual(["one", "two"]);
      expect(delta.checkpoint).toBeUndefined();
    });

    it("a second read against what is now stored adds nothing new, and still takes no checkpoint", async () => {
      const { cwd, path } = archiveFixture();
      const first = await source.read(path, undefined, ctx(cwd));
      const second = await source.read(path, stored(first.messages), ctx(cwd));
      expect(second.sourceOffset).toBe(2);
      expect(second.messages).toEqual([]);
      expect(second.checkpoint).toBeUndefined();
    });

    it("refuses a transcript whose header names another project or session", async () => {
      const { cwd, path } = archiveFixture();
      const elsewhere = tempDir("lcm-omp-archive-elsewhere-");
      await expect(source.read(path, undefined, ctx(elsewhere)))
        .rejects.toThrow("OMP transcript cwd does not match requested project");
      await expect(source.read(path, undefined, ctx(cwd, { sessionId: "another" })))
        .rejects.toThrow("OMP transcript session id does not match request");
    });

    it("refuses stored history the archive does not hold in order", async () => {
      const { cwd, path } = archiveFixture();
      const rewritten = [{ role: "user", content: "not one" }, { role: "assistant", content: "two" }];
      await expect(source.read(path, stored(rewritten), ctx(cwd)))
        .rejects.toThrow("OMP transcript does not hold the stored history in order; check the original transcript and redaction settings before retrying");
    });

    it("locates and refuses loudly the same as a live transcript", () => {
      const { cwd, path } = archiveFixture();
      expect(source.locate({ sessionId, cwd, transcriptPath: path })).toBe(realpathSync(path));
      expect(() => source.locate({ sessionId, cwd, transcriptPath: join(cwd, "missing.jsonl.gz") }))
        .toThrow("OMP transcript is unreadable");
    });

    describe("a rewind inside the archive", () => {
      /** `[id, parentId]`: an entry's place in the tree. */
      type At = [string, string | null];
      const timestamp = "2026-08-01T00:00:00.000Z";
      const say = ([id, parentId]: At, role: string, text: string) =>
        JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] } });
      const rewindTo = ([id, parentId]: At) => JSON.stringify({ type: "branch_summary", id, parentId, timestamp, fromId: "a2", summary: "" });
      const trunk = [say(["u1", null], "user", "first question"), say(["a1", "u1"], "assistant", "first answer")];
      const wrongTurn = [say(["u2", "a1"], "user", "wrong turn"), say(["a2", "u2"], "assistant", "wrong answer")];
      const betterTurn = [rewindTo(["b1", "a1"]), say(["u3", "b1"], "user", "better question"), say(["a3", "u3"], "assistant", "better answer")];
      const as = (role: string, content: string) => ({ role, content });

      function archivedTreeFixture(lines: string[]): { cwd: string; path: string } {
        const cwd = tempDir("lcm-omp-archive-tree-");
        const path = join(cwd, "session.jsonl.gz");
        const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd });
        writeFileSync(path, gzipSync(`${[header, ...lines].join("\n")}\n`));
        return { cwd, path };
      }

      it("a fresh import of an archived rewind holds only the live path", async () => {
        const { cwd, path } = archivedTreeFixture([...trunk, ...wrongTurn, ...betterTurn]);
        const delta = await source.read(path, undefined, ctx(cwd));
        expect(delta.messages.map((m) => m.content)).toEqual(["first question", "first answer", "better question", "better answer"]);
        expect(delta.checkpoint).toBeUndefined();
      });

      it("a recovery scan keeps stored turns the archived rewind abandoned and adds only the live continuation", async () => {
        const { cwd, path } = archivedTreeFixture([...trunk, ...wrongTurn, ...betterTurn]);
        const storedInFileOrder = [
          as("user", "first question"), as("assistant", "first answer"), as("user", "wrong turn"), as("assistant", "wrong answer"),
        ];
        const delta = await source.read(path, stored(storedInFileOrder), ctx(cwd));
        expect(delta.sourceOffset).toBe(4);
        expect(delta.messages.map((m) => m.content)).toEqual(["better question", "better answer"]);
      });
    });
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
