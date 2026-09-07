/**
 * E2E Flow Tests: Hooks (Flows 14, 15, 16)
 *
 * Flow 14: SessionEnd hook ingests messages
 * Flow 15: PreCompact hook returns exit 2 with summary
 * Flow 16: Auto-heal validates hooks without throwing
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";
import { DaemonClient } from "../../../src/daemon/client.js";

let handle: HarnessHandle | null = null;

beforeAll(async () => {
  handle = await createHarness("mock");
}, 60_000);

afterAll(async () => {
  if (handle) {
    await handle.cleanup();
    handle = null;
  }
});

describe("Flow 14: SessionEnd hook", { timeout: 60_000 }, () => {
  it("ingests messages and returns exit 0", async () => {
    const h = handle!;
    const client = new DaemonClient(`http://127.0.0.1:${h.daemonPort}`);
    const stdinData = JSON.stringify({
      session_id: "e2e-session-end-test",
      cwd: h.tmpDir,
      transcript_path: h.fixturePath,
    });

    const { handleSessionEnd } = await import("../../../src/hooks/session-end.js");
    const result = await handleSessionEnd(stdinData, client, h.daemonPort);

    expect(result.exitCode).toBe(0);
  });
});

describe("Flow 15: PreCompact hook", { timeout: 60_000 }, () => {
  it("returns exit 0 with summary text", async () => {
    const h = handle!;

    // First ingest some data so there is something to compact
    await h.client.post("/ingest", {
      session_id: "e2e-precompact-test",
      cwd: h.tmpDir,
      messages: [
        { role: "user", content: "Hello, can you help me with my project?", tokenCount: 10 },
        { role: "assistant", content: "Of course! I am happy to help you.", tokenCount: 10 },
        { role: "user", content: "I need to design a database schema.", tokenCount: 10 },
        { role: "assistant", content: "Let me walk you through a schema design.", tokenCount: 10 },
      ],
    });

    const client = new DaemonClient(`http://127.0.0.1:${h.daemonPort}`);
    const stdinData = JSON.stringify({
      session_id: "e2e-precompact-test",
      cwd: h.tmpDir,
      client: "claude",
    });

    const { handlePreCompact } = await import("../../../src/hooks/compact.js");
    const result = await handlePreCompact(stdinData, client, h.daemonPort);

    // PreCompact never blocks native compaction: always exit 0 with the summary on stdout
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
  });
});

describe("Flow 16: Auto-heal", { timeout: 60_000 }, () => {
  it("strips duplicate lcm hooks from a real settings.json and keeps mcpServers.lcm", async () => {
    const { validateAndFixHooks } = await import("../../../src/hooks/auto-heal.js");
    const { REQUIRED_HOOKS } = await import("../../../installer/install.js");
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    const h = handle!;

    const settingsPath = join(h.tmpDir, "claude-settings", "settings.json");
    fs.mkdirSync(join(h.tmpDir, "claude-settings"), { recursive: true });
    const hooks: Record<string, unknown[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) {
      hooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
    }
    hooks.PostToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks, mcpServers: { lcm: { command: "lcm", args: ["mcp"] } } }));

    validateAndFixHooks({
      readFileSync: (p: string, enc: string) => fs.readFileSync(p, enc as BufferEncoding),
      writeFileSync: fs.writeFileSync,
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      appendFileSync: fs.appendFileSync,
      settingsPath,
      logPath: join(h.tmpDir, "claude-settings", "auto-heal.log"),
    });

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const remaining = JSON.stringify(after.hooks ?? {});
    for (const { command } of REQUIRED_HOOKS) expect(remaining).not.toContain(command);
    expect(after.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }]);
    expect(after.mcpServers.lcm).toEqual({ command: "lcm", args: ["mcp"] });
  });

  it("does nothing when no settings.json exists", async () => {
    const { validateAndFixHooks } = await import("../../../src/hooks/auto-heal.js");
    const writes: string[] = [];
    validateAndFixHooks({
      readFileSync: (): string => { throw new Error("ENOENT"); },
      writeFileSync: (p: string): void => { writes.push(p); },
      existsSync: (): boolean => false,
      mkdirSync: (): void => {},
      appendFileSync: (): void => {},
      settingsPath: "/nonexistent/settings.json",
      logPath: "/nonexistent/auto-heal.log",
    });
    expect(writes).toEqual([]);
  });
});
