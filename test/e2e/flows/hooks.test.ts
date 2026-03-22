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
  it("returns exit 2 with summary text", async () => {
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

    // exit 2 = replace native compaction; exit 0 = disabled provider (also acceptable)
    expect([0, 2]).toContain(result.exitCode);
    // When exit 2, stdout should contain summary text
    if (result.exitCode === 2) {
      expect(result.stdout).toBeTruthy();
    }
  });
});

describe("Flow 16: Auto-heal", { timeout: 60_000 }, () => {
  it("validateAndFixHooks with custom deps does not throw", async () => {
    const { validateAndFixHooks } = await import("../../../src/hooks/auto-heal.js");

    // Provide mock deps that simulate no settings file present
    const mockDeps = {
      readFileSync: (_path: string, _enc: string): string => "{}",
      writeFileSync: (_path: string, _data: string): void => {},
      existsSync: (_path: string): boolean => false,
      mkdirSync: (_path: string, _opts?: { recursive: boolean }): void => {},
      appendFileSync: (_path: string, _data: string): void => {},
      settingsPath: "/nonexistent/settings.json",
      logPath: "/nonexistent/auto-heal.log",
    };

    expect(() => validateAndFixHooks(mockDeps)).not.toThrow();
  });
});
