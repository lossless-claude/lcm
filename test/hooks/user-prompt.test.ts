import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock("../../src/hooks/extractors.js", () => ({
  extractUserPromptEvents: vi.fn(),
}));

vi.mock("../../src/hooks/events-db.js", () => ({
  EventsDb: vi.fn(),
}));

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn().mockReturnValue("/tmp/test-events.db"),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
import { extractUserPromptEvents } from "../../src/hooks/extractors.js";
import { EventsDb } from "../../src/hooks/events-db.js";

const mockEnsureDaemon = vi.mocked(ensureDaemon);
const mockExtractUserPromptEvents = vi.mocked(extractUserPromptEvents);
const MockEventsDb = vi.mocked(EventsDb);

describe("handleUserPromptSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns hint when daemon returns matches", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Decided to use PostgreSQL for storage", "Fixed race condition in compaction"],
        ids: ["uuid-1", "uuid-2"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what database do we use?" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-context>");
    expect(result.stdout).toContain("PostgreSQL");
  });

  it("includes surfaced-memory-ids comment when ids are returned", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Use React for frontend"],
        ids: ["abc-123"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what framework?" }),
      client as any,
    );
    expect(result.stdout).toContain("<!-- surfaced-memory-ids: abc-123 -->");
  });

  it("omits surfaced-memory-ids comment when ids are absent", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        hints: ["Use React for frontend"],
      }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "what framework?" }),
      client as any,
    );
    expect(result.stdout).not.toContain("surfaced-memory-ids");
  });

  it("returns empty when daemon returns no matches", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj", prompt: "hello" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("returns learning-instruction when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleUserPromptSubmit("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it("returns learning-instruction when prompt is missing", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ session_id: "s1", cwd: "/proj" }),
      client as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<learning-instruction>");
  });

  it("includes learning-instruction block in output", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["some context hint"] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).toContain("lcm_store");
    expect(result.stdout).toContain("category:decision");
    expect(result.stdout).toContain("</learning-instruction>");
  });

  it("includes learning-instruction even when no memory-context hints", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: [] }),
    };
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
      mockClient as any,
    );
    expect(result.stdout).toContain("<learning-instruction>");
    expect(result.stdout).not.toContain("<memory-context>");
  });

  it("extracts decision events to sidecar before prompt-search", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const mockInsertEvent = vi.fn();
    const mockClose = vi.fn();
    MockEventsDb.mockImplementation(() => ({
      insertEvent: mockInsertEvent,
      close: mockClose,
    }) as any);
    mockExtractUserPromptEvents.mockReturnValue([
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
    ]);
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["some hint"] }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "we decided to use SQLite", cwd: "/proj", session_id: "s1" }),
      mockClient as any,
    );

    expect(result.exitCode).toBe(0);
    expect(mockExtractUserPromptEvents).toHaveBeenCalledWith("we decided to use SQLite");
    expect(mockInsertEvent).toHaveBeenCalledWith(
      "s1",
      { type: "decision", category: "decision", data: "use SQLite", priority: 1 },
      "UserPromptSubmit",
    );
    expect(mockClose).toHaveBeenCalled();
    // prompt-search still called
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.any(Object));
  });

  it("continues normally if sidecar extraction fails", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    mockExtractUserPromptEvents.mockImplementation(() => {
      throw new Error("extraction exploded");
    });
    const mockClient = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ hints: ["recovered hint"] }),
    };

    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: "hello world", cwd: "/proj", session_id: "s2" }),
      mockClient as any,
    );

    expect(result.exitCode).toBe(0);
    // prompt-search still called despite extraction failure
    expect(mockClient.post).toHaveBeenCalledWith("/prompt-search", expect.any(Object));
    expect(result.stdout).toContain("<memory-context>");
    expect(result.stdout).toContain("recovered hint");
  });
});
