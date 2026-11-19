import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { tokenadeFold } from "../src/message-content.js";
import { ScrubEngine } from "../src/scrub.js";
import { applyFoldRepair, planFoldRepair, restoreFold, tokenadeStash, tokenadeStashDir } from "../src/tokenade-folds.js";
import { transcriptSource } from "../src/transcript-source.js";

const placeholder = (tokens: number, hash: string) => `[tokenade:elided ${tokens} tokens on cold resume — recover: tokenade expand-ref ${hash}]`;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const line = (value: unknown) => JSON.stringify(value) + "\n";

// A dead call's input keeps its first line; a stale result is folded whole.
const head = "cd repo && python3 - <<'PY'";
const command = `${head}\n${"print('restored_command_body')\n".repeat(40)}PY`;
const output = `restored_output_start\n${"row of a long tool output\n".repeat(160)}`;

describe("tokenade stash", () => {
  let stash: string;
  beforeEach(() => { stash = mkdtempSync(join(tmpdir(), "lcm-stash-")); });
  afterEach(() => rmSync(stash, { recursive: true, force: true }));

  it("resolves the folder as tokenade does, treating an empty variable as unset", () => {
    expect(tokenadeStashDir({ TOKENADE_STASH_DIR: "/s", XDG_CACHE_HOME: "/x" })).toBe("/s");
    expect(tokenadeStashDir({ TOKENADE_STASH_DIR: "", XDG_CACHE_HOME: "/x", LOCALAPPDATA: "/l" })).toBe(join("/x", "tokenade", "stash"));
    expect(tokenadeStashDir({ LOCALAPPDATA: "/l", HOME: "/h" })).toBe(join("/l", "tokenade", "stash"));
    expect(tokenadeStashDir({ HOME: "/h", USERPROFILE: "/u" })).toBe(join("/h", ".cache", "tokenade", "stash"));
    expect(tokenadeStashDir({ USERPROFILE: "/u" })).toBe(join("/u", "AppData", "Local", "tokenade", "stash"));
    expect(tokenadeStashDir({})).toBeUndefined();
  });

  it("returns a file only when its bytes hash to the name it is read by", () => {
    writeFileSync(join(stash, `${hashOf(output)}.txt`), output);
    writeFileSync(join(stash, "aaaaaaaaaaaa.api.rest.txt"), output);
    const cut = `${output}\n[tokenade:stash truncated — original was 9 bytes, kept first 1 + last 1]\n`;
    writeFileSync(join(stash, `${hashOf(cut)}.txt`), cut);
    const read = tokenadeStash(stash);
    expect(read(hashOf(output))).toBe(output);
    expect(read("aaaaaaaaaaaa")).toBeUndefined();
    expect(read(hashOf(cut))).toBeUndefined();
    expect(read("bbbbbbbbbbbb")).toBeUndefined();
    expect(tokenadeStash(join(stash, "missing"))(hashOf(output))).toBeUndefined();
  });

  it("restores a fold only from a copy that begins with the opening it kept", () => {
    const folded = `${head}\n${placeholder(400, hashOf(command))}`;
    expect(tokenadeFold(folded)).toEqual({ head, hash: hashOf(command) });
    expect(tokenadeFold(placeholder(400, "0123456789ab"))).toEqual({ hash: "0123456789ab" });
    expect(tokenadeFold(`${placeholder(400, "0123456789ab")} quoted`)).toBeUndefined();
    const read = (hash: string) => (hash === hashOf(command) ? command : undefined);
    expect(restoreFold(folded, read)).toBe(command);
    expect(restoreFold(`cd elsewhere\n${placeholder(400, hashOf(command))}`, read)).toBeUndefined();
    expect(restoreFold("[tokenade:elided 400 tokens on cold resume — recover: (original not stashed)]", read)).toBeUndefined();
  });
});

describe("a Claude transcript tokenade folded before lcm stored it", () => {
  let db: DatabaseSync, dir: string, stash: string, path: string, capture: SessionCapture;
  const scrubber = new ScrubEngine([], ["SECRET_EXAMPLE"]);
  const scrub = (text: string) => scrubber.scrubWithCounts(text).text;
  const folded = [
    line({ message: { role: "user", content: "q1" } }),
    line({ message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Bash",
      input: { command: `${head}\n${placeholder(380, hashOf(command))}` } }] } }),
    line({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: placeholder(1100, hashOf(output)) }] }] } }),
    line({ message: { role: "assistant", content: "done" } }),
  ];
  const stashOriginals = () => {
    writeFileSync(join(stash, `${hashOf(command)}.txt`), command);
    writeFileSync(join(stash, `${hashOf(output)}.txt`), output);
  };
  const stored = () => db.prepare("SELECT message_id AS id, content, token_count AS tokens FROM messages ORDER BY seq").all() as Array<{ id: number; content: string; tokens: number }>;
  const storedInputs = () => (db.prepare("SELECT input FROM transcript_tool_calls").all() as Array<{ input: string }>).map((row) => row.input);
  const input = { cwd: "", transcriptPath: "", sessionId: "session", client: "claude" };
  // Shifts the file's first bytes without adding a message, so the next capture re-reads it whole
  // and verifies stored history against the folded transcript before appending.
  const appendAfterRewrite = (text: string) => writeFileSync(path, line({ type: "custom-title", customTitle: "t" }) + readFileSync(path, "utf8") + line({ message: { role: "user", content: text } }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lcm-folds-"));
    stash = join(dir, "stash");
    mkdirSync(stash);
    vi.stubEnv("TOKENADE_STASH_DIR", stash);
    path = join(dir, "session.jsonl");
    Object.assign(input, { cwd: dir, transcriptPath: path });
    writeFileSync(path, folded.join(""));
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    capture = new SessionCapture(db, "project", scrubber);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the stashed originals of an output and an input, and later captures still verify them", async () => {
    stashOriginals();
    const written = await capture.captureTranscript(input);
    expect(written?.folds).toEqual({ expanded: 2, kept: 0 });
    expect(stored().map((row) => row.content)).toEqual(["q1", "Bash", output, "done"]);
    expect(stored()[2].tokens).toBeGreaterThan(1000);
    expect(storedInputs()).toEqual([command]);

    appendAfterRewrite("q2");
    expect((await capture.captureTranscript(input))?.records.map((record) => record.content)).toEqual(["q2"]);
  });

  it("stores the placeholder, and says so, when the stash lacks the original", async () => {
    const written = await capture.captureTranscript(input);
    expect(written?.folds).toEqual({ expanded: 0, kept: 2 });
    expect(stored()[2].content).toBe(placeholder(1100, hashOf(output)));
    expect(storedInputs()[0]).toContain("[tokenade:elided ");
  });

  it("restores nothing for a read that does not ask, as a rebuild or a repair reads", async () => {
    stashOriginals();
    const delta = await transcriptSource("claude").read(path, undefined, { ...input, scrub });
    expect(delta.folds).toBeUndefined();
    expect(delta.messages[2].content).toBe(placeholder(1100, hashOf(output)));
  });

  it("repairs stored placeholders from the stash, and a later capture still verifies them", async () => {
    await capture.captureTranscript(input);
    expect((await planFoldRepair(db, { sessionId: "session", transcriptPath: path, scrub })).kept).toBe(2);

    stashOriginals();
    const plan = await planFoldRepair(db, { sessionId: "session", transcriptPath: path, scrub });
    expect(plan).toMatchObject({ kind: "repairable", kept: 0 });
    expect(plan.rows.map((row) => row.content)).toEqual([output]);
    expect(plan.calls.map((call) => call.input)).toEqual([command]);
    expect(applyFoldRepair(db, plan)).toBe(2);
    expect(stored().map((row) => row.content)).toEqual(["q1", "Bash", output, "done"]);
    expect(storedInputs()).toEqual([command]);
    const indexed = (id: number) => (db.prepare("SELECT content FROM messages_fts WHERE rowid = ?").get(id) as { content: string }).content;
    expect(indexed(stored()[2].id)).toContain("restored_output_start");
    expect(indexed(stored()[1].id)).toContain("restored_command_body");
    expect(() => applyFoldRepair(db, plan)).toThrow(/changed before repair/);

    expect(await planFoldRepair(db, { sessionId: "session", transcriptPath: path, scrub })).toMatchObject({ kind: "aligned", kept: 0 });
    appendAfterRewrite("q2");
    expect((await capture.captureTranscript(input))?.records.map((record) => record.content)).toEqual(["q2"]);
  });

  it("never replaces an original lcm stored before the fold", async () => {
    writeFileSync(path, [
      folded[0],
      line({ message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Bash", input: { command } }] } }),
      line({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: output }] }] } }),
      folded[3],
    ].join(""));
    await capture.captureTranscript(input);
    writeFileSync(path, folded.join(""));
    stashOriginals();
    expect(await planFoldRepair(db, { sessionId: "session", transcriptPath: path, scrub })).toMatchObject({ kind: "aligned", rows: [], calls: [], kept: 0 });
  });
});
