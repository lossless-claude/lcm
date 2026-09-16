import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSubagentTranscripts, walkSubagentTranscripts } from "../src/subagent-attribution.js";

describe("discoverSubagentTranscripts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSessionDir(): string {
    const root = mkdtempSync(join(tmpdir(), "lcm-subagent-discover-test-"));
    dirs.push(root);
    const sessionDir = join(root, "session-parent");
    mkdirSync(join(sessionDir, "subagents"), { recursive: true });
    return sessionDir;
  }

  it("returns empty when the session has no subagents/ directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-subagent-discover-test-"));
    dirs.push(root);
    expect(discoverSubagentTranscripts(join(root, "session-parent"))).toEqual([]);
  });

  it("finds a top-level and a workflow-nested transcript, skips journal.jsonl, and attributes both to the owning session", () => {
    const sessionDir = makeSessionDir();
    const subagentsDir = join(sessionDir, "subagents");
    const workflowRunDir = join(subagentsDir, "workflows", "wf_x");
    mkdirSync(workflowRunDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-flat.jsonl"), "");
    writeFileSync(join(subagentsDir, "agent-flat.meta.json"), JSON.stringify({ agentType: "explorer", description: "look" }));
    writeFileSync(join(workflowRunDir, "agent-wf-child.jsonl"), "");
    writeFileSync(join(workflowRunDir, "agent-wf-child.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }));
    writeFileSync(join(workflowRunDir, "journal.jsonl"), "");

    const found = discoverSubagentTranscripts(sessionDir).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(found).toEqual([
      {
        path: join(subagentsDir, "agent-flat.jsonl"),
        sessionId: "agent-flat",
        mtime: expect.any(Number),
        attribution: { parentSessionId: "session-parent", subagentType: "explorer", subagentDesc: "look" },
      },
      {
        path: join(workflowRunDir, "agent-wf-child.jsonl"),
        sessionId: "agent-wf-child",
        mtime: expect.any(Number),
        // Parent is the session that owns subagents/, not the wf_* run directory.
        attribution: { parentSessionId: "session-parent", subagentType: "workflow-subagent", subagentDesc: null },
      },
    ]);
  });

  it("prefers the sidecar's parentAgentId over the owning folder, prefixed to match a sibling session id", () => {
    const sessionDir = makeSessionDir();
    const subagentsDir = join(sessionDir, "subagents");
    writeFileSync(join(subagentsDir, "agent-nested.jsonl"), "");
    writeFileSync(join(subagentsDir, "agent-nested.meta.json"), JSON.stringify({ agentType: "worker", parentAgentId: "dispatcher-id" }));

    const [found] = discoverSubagentTranscripts(sessionDir);
    expect(found.attribution.parentSessionId).toBe("agent-dispatcher-id");
  });

  it("ignores an empty parentAgentId and falls back to the owning folder", () => {
    const sessionDir = makeSessionDir();
    const subagentsDir = join(sessionDir, "subagents");
    writeFileSync(join(subagentsDir, "agent-a.jsonl"), "");
    writeFileSync(join(subagentsDir, "agent-a.meta.json"), JSON.stringify({ parentAgentId: "" }));

    const [found] = discoverSubagentTranscripts(sessionDir);
    expect(found.attribution.parentSessionId).toBe("session-parent");
  });

  it("leaves attribution all-null when the sidecar is missing", () => {
    const sessionDir = makeSessionDir();
    writeFileSync(join(sessionDir, "subagents", "agent-orphan.jsonl"), "");

    const [found] = discoverSubagentTranscripts(sessionDir);
    expect(found.attribution).toEqual({ parentSessionId: null, subagentType: null, subagentDesc: null });
  });

  it("leaves attribution all-null when the sidecar has invalid JSON, without throwing", () => {
    const sessionDir = makeSessionDir();
    writeFileSync(join(sessionDir, "subagents", "agent-bad.jsonl"), "");
    writeFileSync(join(sessionDir, "subagents", "agent-bad.meta.json"), "{not json");

    const [found] = discoverSubagentTranscripts(sessionDir);
    expect(found.attribution).toEqual({ parentSessionId: null, subagentType: null, subagentDesc: null });
  });

  it("skips symlinked transcripts and symlinked directories", () => {
    const sessionDir = makeSessionDir();
    const subagentsDir = join(sessionDir, "subagents");
    const outside = join(sessionDir, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "agent-linked.jsonl"), "");
    symlinkSync(join(outside, "agent-linked.jsonl"), join(subagentsDir, "agent-link.jsonl"));
    symlinkSync(outside, join(subagentsDir, "linked-dir"));

    expect(discoverSubagentTranscripts(sessionDir)).toEqual([]);
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

  it("finds subagent transcripts across projects and sessions, through the same walker", () => {
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
