import { describe, it, expect, vi } from "vitest";
import { handleSessionStart } from "../../src/hooks/restore.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock("../../src/hooks/events-db.js", () => ({
  EventsDb: vi.fn().mockImplementation(() => ({
    pruneProcessed: vi.fn(),
    pruneUnprocessed: vi.fn().mockReturnValue({ pruned: 0 }),
    pruneErrorLog: vi.fn().mockReturnValue(0),
    getUnprocessed: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  })),
}));

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn().mockReturnValue("/tmp/test-events.db"),
}));

vi.mock("../../src/hooks/session-end.js", () => ({
  firePromoteEventsRequest: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);

describe("handleSessionStart", () => {
  it("outputs context and exits 0 on success", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "<memory-orientation>\nMemory active\n</memory-orientation>" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "SessionStart" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
  });

  it("exits 0 with empty output when daemon down", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleSessionStart("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("includes learned-insights block when insights returned from daemon", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        context: "<memory-orientation>\nMemory active\n</memory-orientation>",
        insights: [
          { content: "Always use async/await for DB calls", confidence: 0.8, tags: ["source:passive-capture", "category:pattern"] },
          { content: "Prefer PromotedStore over raw SQL", confidence: 0.6, tags: ["source:passive-capture"] },
        ],
      }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
    expect(result.stdout).toContain('<learned-insights source="passive-capture">');
    expect(result.stdout).toContain("Always use async/await for DB calls");
    expect(result.stdout).toContain("confidence: 0.8");
    expect(result.stdout).toContain("</learned-insights>");
  });

  it("omits learned-insights block when daemon returns no insights", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "some context" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s2", cwd: "/proj" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("<learned-insights");
  });

  it("omits learned-insights block when insights array is empty", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "some context", insights: [] }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s3", cwd: "/proj" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("<learned-insights");
  });

  it("triggers promote-events when unprocessed events exist", async () => {
    const { EventsDb } = await import("../../src/hooks/events-db.js");
    const { firePromoteEventsRequest } = await import("../../src/hooks/session-end.js");
    const mockFirePromote = vi.mocked(firePromoteEventsRequest);
    mockFirePromote.mockClear();

    vi.mocked(EventsDb).mockImplementationOnce(() => ({
      pruneProcessed: vi.fn(),
      pruneUnprocessed: vi.fn().mockReturnValue({ pruned: 0 }),
      pruneErrorLog: vi.fn().mockReturnValue(0),
      getUnprocessed: vi.fn().mockReturnValue([{ event_id: 1 }]),
      close: vi.fn(),
    }) as any);

    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "" }),
    };
    await handleSessionStart(JSON.stringify({ session_id: "s4", cwd: "/proj" }), client as any);
    expect(mockFirePromote).toHaveBeenCalledWith(3737, { cwd: "/proj" });
  });
});
