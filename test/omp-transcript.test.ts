import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractOmpSessionMeta,
  extractOmpTurnModels,
  findAllOmpTranscripts,
  findOmpSessionFiles,
  parseOmpTranscript,
  parseOmpTranscriptRecord,
} from "../src/omp-transcript.js";

/**
 * The parser answers "what memory does this OMP session file hold" from the
 * entry shapes OMP v18 persists: a title slot, a session header, message
 * entries with camelCase roles, and state entries that carry no memory.
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

const header = (cwd: string, id = "01a0c127-f3c1-7000-af32-68cf17f6be65") =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-20T23:30:16.129Z", cwd });

const entry = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, id: "e1", parentId: null, timestamp: "2026-09-20T23:30:16.129Z", ...extra });

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  entry("message", { message: { role, content, timestamp: 1760000000000, ...extra } });

const titleSlot = () =>
  JSON.stringify({ type: "title", v: 1, title: "Scouting OMP integration surface", source: "auto", updatedAt: "2026-09-21T08:26:11.135Z", pad: " ".repeat(40) });

describe("parseOmpTranscriptRecord", () => {
  it("reads the header's id and cwd", () => {
    expect(parseOmpTranscriptRecord(header("/work/project", "sess-1")).sessionMeta)
      .toEqual({ id: "sess-1", cwd: "/work/project" });
  });

  it("keeps user prose as a user message", () => {
    const parsed = parseOmpTranscriptRecord(message("user", [{ type: "text", text: "hello" }]));
    expect(parsed.message).toEqual([{ role: "user", content: "hello", tokenCount: expect.any(Number) }]);
  });

  it("keeps assistant prose and only the name of each tool call", () => {
    const parsed = parseOmpTranscriptRecord(message("assistant", [
      { type: "thinking", text: "hidden reasoning" },
      { type: "text", text: "Running it." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "rm -rf /tmp/x" } },
    ]));
    expect(parsed.message).toEqual([
      { role: "assistant", content: "Running it.", tokenCount: expect.any(Number) },
      { role: "tool", content: "bash", tokenCount: expect.any(Number) },
    ]);
  });

  it("keeps a tool result's output and marks a failure", () => {
    expect(parseOmpTranscriptRecord(message("toolResult", [{ type: "text", text: "exit 1" }], { toolCallId: "call_1", toolName: "bash", isError: true })).message)
      .toEqual([{ role: "tool", content: "[tool error]\nexit 1", tokenCount: expect.any(Number) }]);
    expect(parseOmpTranscriptRecord(message("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "call_2", toolName: "read" })).message)
      .toEqual([{ role: "tool", content: "ok", tokenCount: expect.any(Number) }]);
  });

  it("stores nothing for entries that carry no memory", () => {
    for (const record of [
      titleSlot(),
      entry("title_change", { title: "renamed", source: "user" }),
      entry("custom", { customType: "tool_execution_start", data: { toolName: "bash" } }),
      entry("custom_message", { customType: "lcm-memory", content: "injected context", attribution: "agent" }),
      entry("compaction", { summary: "collapsed history", firstKeptEntryId: "e9" }),
      entry("reset_boundary"),
      entry("mode_change", { mode: "plan" }),
      entry("model_change", { model: "openai/gpt-5" }),
      entry("ttsr_injection", { injectedRules: ["a"] }),
      message("developer", [{ type: "text", text: "AGENTS.md contents" }]),
      message("user", [{ type: "text", text: "   " }]),
    ]) {
      expect(parseOmpTranscriptRecord(record)).toEqual({});
    }
  });

  it("throws on malformed JSON so each caller applies its own policy", () => {
    expect(() => parseOmpTranscriptRecord("{not json")).toThrow();
  });
});

describe("parseOmpTranscript", () => {
  function fixture(lines: string[]): string {
    const dir = tempDir("lcm-omp-transcript-");
    const path = join(dir, "2026-09-20T23-30-16-129Z_01a0c127-f3c1-7000-af32-68cf17f6be65.jsonl");
    writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
    return path;
  }

  it("reads past the title slot to the messages, in order", () => {
    const path = fixture([
      titleSlot(), header("/work/project"),
      message("user", [{ type: "text", text: "one" }]),
      entry("custom", { customType: "tool_execution_start", data: {} }),
      message("assistant", [{ type: "text", text: "two" }]),
    ]);
    expect(parseOmpTranscript(path).map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("skips malformed records rather than failing the read", () => {
    const path = fixture([header("/work/project"), "{broken", message("user", [{ type: "text", text: "kept" }])]);
    expect(parseOmpTranscript(path).map((m) => m.content)).toEqual(["kept"]);
  });

  it("defers an unterminated final record for a live read and includes it for an import", () => {
    const dir = tempDir("lcm-omp-tail-");
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${header("/work/project")}\n${message("user", [{ type: "text", text: "complete" }])}\n${message("user", [{ type: "text", text: "still-writing" }])}`);

    expect(parseOmpTranscript(path, false).map((m) => m.content)).toEqual(["complete"]);
    expect(parseOmpTranscript(path, true).map((m) => m.content)).toEqual(["complete", "still-writing"]);
  });

  it("returns nothing for an unreadable file", () => {
    expect(parseOmpTranscript(join(tempDir("lcm-omp-missing-"), "absent.jsonl"))).toEqual([]);
  });
});

describe("extractOmpSessionMeta", () => {
  it("reads the header whether or not the file opens with a title slot", () => {
    const withSlot = tempDir("lcm-omp-meta-");
    const a = join(withSlot, "a.jsonl");
    writeFileSync(a, `${titleSlot()}\n${header("/work/project", "sess-a")}\n`);
    expect(extractOmpSessionMeta(a)).toEqual({ id: "sess-a", cwd: "/work/project" });

    const legacy = tempDir("lcm-omp-legacy-");
    const b = join(legacy, "b.jsonl");
    writeFileSync(b, `${header("/work/old", "sess-b")}\n`);
    expect(extractOmpSessionMeta(b)).toEqual({ id: "sess-b", cwd: "/work/old" });
  });

  it("returns undefined when there is no header", () => {
    const dir = tempDir("lcm-omp-noheader-");
    const path = join(dir, "c.jsonl");
    writeFileSync(path, `${message("user", [{ type: "text", text: "no header" }])}\n`);
    expect(extractOmpSessionMeta(path)).toBeUndefined();
  });
});

describe("extractOmpTurnModels", () => {
  it("maps each tool-call id to the model on the assistant entry that dispatched it", () => {
    const dir = tempDir("lcm-omp-models-");
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      header("/work/project"),
      message("assistant", [{ type: "toolCall", id: "call_1", name: "bash" }, { type: "toolCall", id: "call_2", name: "read" }], { model: "~z-ai/glm-flash-latest" }),
      message("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "call_1", toolName: "bash" }),
    ].map((line) => `${line}\n`).join(""));

    expect([...extractOmpTurnModels(path)]).toEqual([
      ["call_1", "~z-ai/glm-flash-latest"],
      ["call_2", "~z-ai/glm-flash-latest"],
    ]);
  });

  it("returns an empty map for an unreadable file", () => {
    expect(extractOmpTurnModels(join(tempDir("lcm-omp-models-missing-"), "absent.jsonl")).size).toBe(0);
  });
});

describe("findOmpSessionFiles", () => {
  function writeSession(bucketDir: string, name: string, cwd: string, id: string, mtime?: Date): string {
    mkdirSync(bucketDir, { recursive: true });
    const path = join(bucketDir, name);
    writeFileSync(path, `${titleSlot()}\n${header(cwd, id)}\n${message("user", [{ type: "text", text: "hi" }])}\n`);
    if (mtime) utimesSync(path, mtime, mtime);
    return path;
  }

  it("discovers every bucket's sessions with the cwd from each header", () => {
    const root = tempDir("lcm-omp-sessions-");
    writeSession(join(root, "-work-project"), "2026-09-20T10-00-00-000Z_sess-1.jsonl", "/work/project", "sess-1");
    writeSession(join(root, "-tmp-scratch"), "2026-09-20T11-00-00-000Z_sess-2.jsonl", "/tmp/scratch", "sess-2");

    const files = findOmpSessionFiles(root);
    expect(files.map((f) => [f.sessionId, f.cwd]).sort()).toEqual([["sess-1", "/work/project"], ["sess-2", "/tmp/scratch"]]);
  });

  it("skips nested and non-jsonl entries inside a bucket", () => {
    const root = tempDir("lcm-omp-shape-");
    const bucket = join(root, "-work-project");
    writeSession(bucket, "session.jsonl", "/work/project", "sess-1");
    mkdirSync(join(bucket, "subagents"), { recursive: true });
    writeFileSync(join(bucket, "artifacts.md"), "not a session\n");

    expect(findOmpSessionFiles(root).map((f) => f.sessionId)).toEqual(["sess-1"]);
  });

  it("returns nothing for a missing root", () => {
    expect(findOmpSessionFiles(join(tempDir("lcm-omp-absent-"), "sessions"))).toEqual([]);
  });
});

describe("findAllOmpTranscripts", () => {
  it("keeps the newest transcript per session id and sorts by mtime", () => {
    const root = tempDir("lcm-omp-all-");
    const older = new Date("2026-09-20T10:00:00.000Z");
    const newer = new Date("2026-09-20T12:00:00.000Z");
    // The same session id can appear twice: a short-lived hashed bucket scheme and
    // the path-encoded one, migrated best-effort by OMP.
    mkdirSync(join(root, "sessions", "-work-project"), { recursive: true });
    const first = join(root, "sessions", "-work-project", "2026-09-20T10-00-00-000Z_sess-1.jsonl");
    const second = join(root, "sessions", "-work-project", "2026-09-20T12-00-00-000Z_sess-1.jsonl");
    for (const [path, mtime] of [[first, older], [second, newer]] as const) {
      writeFileSync(path, `${header("/work/project", "sess-1")}\n`);
      utimesSync(path, mtime, mtime);
    }

    const files = findAllOmpTranscripts(root);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(second);
  });

  it("reports sessions whose header names no cwd, for the caller to skip", () => {
    const root = tempDir("lcm-omp-nocwd-");
    mkdirSync(join(root, "sessions", "-work-project"), { recursive: true });
    writeFileSync(join(root, "sessions", "-work-project", "no-cwd.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "sess-x" })}\n`);

    expect(findAllOmpTranscripts(root)).toEqual([{ path: expect.any(String), sessionId: "sess-x", mtime: expect.any(Number), cwd: undefined }]);
  });
});