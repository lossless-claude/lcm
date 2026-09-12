import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSubagentAttribution, walkSubagentTranscripts } from "../src/subagent-attribution.js";

describe("readSubagentAttribution", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-subagent-attr-test-"));
    dirs.push(dir);
    return dir;
  }

  it("falls back to the folder session id when the sidecar has no parentAgentId", () => {
    const dir = makeTmpDir();
    const transcriptPath = join(dir, "agent-child.jsonl");
    writeFileSync(transcriptPath, "");
    writeFileSync(join(dir, "agent-child.meta.json"), JSON.stringify({ agentType: "explorer", description: "d" }));

    const result = readSubagentAttribution(transcriptPath, "owning-session");
    expect(result).toEqual({
      parentSessionId: "owning-session",
      subagentType: "explorer",
      subagentDesc: "d",
    });
  });

  it("prefixes parentAgentId with agent- to match the sibling's session id", () => {
    const dir = makeTmpDir();
    const transcriptPath = join(dir, "agent-nested.jsonl");
    writeFileSync(transcriptPath, "");
    writeFileSync(join(dir, "agent-nested.meta.json"), JSON.stringify({ parentAgentId: "abc123" }));

    const result = readSubagentAttribution(transcriptPath, "owning-session");
    expect(result.parentSessionId).toBe("agent-abc123");
  });

  it("returns all-null when the sidecar file is missing", () => {
    const dir = makeTmpDir();
    const transcriptPath = join(dir, "agent-orphan.jsonl");
    writeFileSync(transcriptPath, "");

    expect(readSubagentAttribution(transcriptPath, "owning-session")).toEqual({
      parentSessionId: null,
      subagentType: null,
      subagentDesc: null,
    });
  });

  it("returns all-null when the sidecar has invalid JSON, without throwing", () => {
    const dir = makeTmpDir();
    const transcriptPath = join(dir, "agent-bad.jsonl");
    writeFileSync(transcriptPath, "");
    writeFileSync(join(dir, "agent-bad.meta.json"), "{not json");

    expect(() => readSubagentAttribution(transcriptPath, "owning-session")).not.toThrow();
    expect(readSubagentAttribution(transcriptPath, "owning-session")).toEqual({
      parentSessionId: null,
      subagentType: null,
      subagentDesc: null,
    });
  });
});

describe("walkSubagentTranscripts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-subagent-walk-test-"));
    dirs.push(dir);
    return dir;
  }

  it("returns empty for a nonexistent projects dir", () => {
    expect(walkSubagentTranscripts("/nonexistent/path")).toEqual([]);
  });

  it("finds subagent transcripts across projects and sessions", () => {
    const root = makeTmpDir();
    const subagentsDir = join(root, "project-a", "session-1", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-x.jsonl"), "");
    writeFileSync(join(subagentsDir, "agent-x.meta.json"), JSON.stringify({ agentType: "worker" }));

    const entries = walkSubagentTranscripts(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("agent-x");
    expect(entries[0].attribution.subagentType).toBe("worker");
    expect(entries[0].attribution.parentSessionId).toBe("session-1");
  });
});
