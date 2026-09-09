import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTranscript } from "../src/transcript.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Writes transcript entries as Claude Code does, one JSON object per line. */
function transcript(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-tagging-"));
  tempDirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const entry = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

describe("role tagging", () => {
  it("stores a tool result as a tool message, not as something the user said", () => {
    const path = transcript([
      entry("user", [{ type: "tool_result", content: "total 24\ndrwxr-xr-x  src" }]),
    ]);
    expect(parseTranscript(path)).toEqual([
      { role: "tool", content: "total 24\ndrwxr-xr-x  src", tokenCount: expect.any(Number) },
    ]);
  });

  it("keeps a plain user turn human", () => {
    const path = transcript([entry("user", [{ type: "text", text: "roda os testes" }])]);
    expect(parseTranscript(path)[0].role).toBe("user");
  });

  it("keeps a string-content turn human", () => {
    const path = transcript([entry("user", "roda os testes")]);
    expect(parseTranscript(path)[0]).toMatchObject({ role: "user", content: "roda os testes" });
  });

  it("calls an entry that mixes human text with a tool result human", () => {
    const path = transcript([
      entry("user", [
        { type: "tool_result", content: "exit 1" },
        { type: "text", text: "isso aqui quebrou" },
      ]),
    ]);
    const [message] = parseTranscript(path);
    expect(message.role).toBe("user");
    expect(message.content).toContain("isso aqui quebrou");
  });

  it("records a tool call by name, never by its input", () => {
    const path = transcript([
      entry("assistant", [{ type: "tool_use", name: "Bash", input: { command: "rm -rf /tmp/x" } }]),
    ]);
    const [message] = parseTranscript(path);
    expect(message).toMatchObject({ role: "tool", content: "Bash" });
    expect(message.content).not.toContain("rm -rf");
  });

  it("marks a failed tool result so it can be found", () => {
    const path = transcript([
      entry("user", [{ type: "tool_result", is_error: true, content: "command not found" }]),
    ]);
    const [message] = parseTranscript(path);
    expect(message.role).toBe("tool");
    expect(message.content).toBe("[tool error]\ncommand not found");
  });

  it("keeps an assistant turn that both speaks and calls a tool as assistant", () => {
    const path = transcript([
      entry("assistant", [
        { type: "text", text: "vou listar os arquivos" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]),
    ]);
    expect(parseTranscript(path)[0]).toMatchObject({ role: "assistant", content: "vou listar os arquivos" });
  });

  it("keeps one transcript entry as one message", () => {
    const path = transcript([
      entry("assistant", [
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Grep", input: {} },
      ]),
    ]);
    const messages = parseTranscript(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Read\nGrep");
  });

  it("still drops an entry that carries no content at all", () => {
    const path = transcript([
      entry("assistant", [{ type: "thinking", thinking: "hmm" }]),
      entry("assistant", [{ type: "text", text: "pronto" }]),
    ]);
    expect(parseTranscript(path).map(m => m.content)).toEqual(["pronto"]);
  });
});
