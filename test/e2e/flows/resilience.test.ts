/**
 * E2E Flow Tests: Resilience (Flows 17, 18, 19)
 *
 * Flow 17: Scrubbing — sensitive patterns redacted from stored content
 * Flow 18: Daemon-down — all hooks return exit 0 when daemon unreachable
 * Flow 19: Status — /status returns project stats
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHarness, openProjectDb, type HarnessHandle } from "../harness.js";
import { DaemonClient } from "../../../src/daemon/client.js";

let handle: HarnessHandle | null = null;

// A real-looking OpenAI API key with 20+ alphanumeric chars after "sk-"
// (no hyphens so it matches the built-in pattern: sk-[A-Za-z0-9]{20,})
const FAKE_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

beforeAll(async () => {
  handle = await createHarness("mock");

  // Ingest data via messages[] — reliable for E2E (no transcript file dependency)
  // Include FAKE_API_KEY which should be redacted by the built-in scrubber
  await handle.client.post("/ingest", {
    session_id: "e2e-resilience-session",
    cwd: handle.tmpDir,
    messages: [
      {
        role: "user",
        content: `I need to implement the storage layer. Here is my API key for testing: ${FAKE_API_KEY}`,
        tokenCount: 20,
      },
      {
        role: "assistant",
        content: "I will help you implement the storage layer using SQLite as the database backend.",
        tokenCount: 20,
      },
      {
        role: "user",
        content: "We decided to use SQLite instead of PostgreSQL because it requires zero infrastructure.",
        tokenCount: 18,
      },
      {
        role: "assistant",
        content: "Great choice. SQLite is perfect for embedded use cases and simplifies deployment.",
        tokenCount: 16,
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  if (handle) {
    await handle.cleanup();
    handle = null;
  }
});

describe("Flow 17: Scrubbing", { timeout: 60_000 }, () => {
  it("scrub engine redacts sensitive API key patterns from stored content", () => {
    const h = handle!;
    const { db, close } = openProjectDb(h.tmpDir);
    try {
      const messages = db.prepare("SELECT content FROM messages").all() as Array<{ content: string }>;
      expect(messages.length).toBeGreaterThan(0);
      const allContent = messages.map((m) => m.content).join(" ");
      // The FAKE_API_KEY matches the built-in pattern sk-[A-Za-z0-9]{20,}
      // and must have been replaced with [REDACTED]
      expect(allContent).not.toContain(FAKE_API_KEY);
      expect(allContent).toContain("[REDACTED]");
    } finally {
      close();
    }
  });
});

describe("Flow 18: Daemon-down resilience", { timeout: 60_000 }, () => {
  it("hooks return exit 0 when daemon is unreachable", async () => {
    // Port 1 is a privileged port that nothing listens on in test environments
    const badClient = new DaemonClient("http://127.0.0.1:1");

    const { handlePreCompact } = await import("../../../src/hooks/compact.js");
    const { handleSessionStart } = await import("../../../src/hooks/restore.js");
    const { handleSessionEnd } = await import("../../../src/hooks/session-end.js");
    const { handleUserPromptSubmit } = await import("../../../src/hooks/user-prompt.js");

    const r1 = await handlePreCompact("{}", badClient, 1);
    expect(r1.exitCode).toBe(0);

    const r2 = await handleSessionStart("{}", badClient, 1);
    expect(r2.exitCode).toBe(0);

    const r3 = await handleSessionEnd("{}", badClient, 1);
    expect(r3.exitCode).toBe(0);

    const r4 = await handleUserPromptSubmit("{}", badClient, 1);
    expect(r4.exitCode).toBe(0);
  });
});

describe("Flow 19: Status", { timeout: 60_000 }, () => {
  it("status returns project stats after ingest", async () => {
    const h = handle!;
    const result = await h.client.post<{
      project: { messageCount: number; summaryCount: number; promotedCount: number };
      daemon: { version: string; uptime: number; port: number };
    }>("/status", {
      cwd: h.tmpDir,
    });

    expect(result.project.messageCount).toBeGreaterThan(0);
    expect(result.daemon.version).toBeTruthy();
    expect(result.daemon.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
