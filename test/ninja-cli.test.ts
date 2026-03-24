import { describe, it, expect } from "vitest";
import { renderFrame, FRAME_LINES } from "../src/cli/render-frame.js";
import { makeProgressState } from "../src/cli/progress-state.js";
import type { RenderOpts } from "../src/cli/render-frame.js";

const nonTTY: RenderOpts = { isTTY: false, width: 80, color: false, verbose: false };
const ttyOpts: RenderOpts = { isTTY: true, width: 80, color: false, verbose: false };
const verboseTTY: RenderOpts = { isTTY: true, width: 80, color: false, verbose: true };

describe("renderFrame — non-TTY mode", () => {
  it("returns empty string when no lastResult", () => {
    const state = makeProgressState({ total: 5 });
    expect(renderFrame(state, nonTTY)).toBe("");
  });

  it("emits one line with session info when lastResult is set", () => {
    const state = makeProgressState({ total: 5 });
    state.completed = 1;
    state.lastResult = {
      sessionId: "agent-abc1234",
      messages: 42,
      tokensBefore: 5000,
      elapsed: 1300,
    };
    const output = renderFrame(state, nonTTY);
    expect(output).toContain("[1/5]");
    expect(output).toContain("agent-abc1234");
    expect(output).toContain("42 msgs");
    expect(output).toContain("~5.0k");
    expect(output).toContain("1.3s");
    expect(output).toMatch(/\n$/);
  });

  it("shows token reduction when tokensAfter < tokensBefore", () => {
    const state = makeProgressState({ total: 3 });
    state.completed = 1;
    state.lastResult = {
      sessionId: "agent-xyz",
      messages: 10,
      tokensBefore: 10000,
      tokensAfter: 500,
      elapsed: 900,
    };
    const output = renderFrame(state, nonTTY);
    expect(output).toContain("~10.0k → 500");
  });

  it("shows provider label when present", () => {
    const state = makeProgressState({ total: 2 });
    state.completed = 1;
    state.lastResult = {
      sessionId: "agent-zzz",
      messages: 20,
      tokensBefore: 2000,
      provider: "Haiku",
      elapsed: 400,
    };
    const output = renderFrame(state, nonTTY);
    expect(output).toContain("[Haiku]");
  });
});

describe("renderFrame — verbose TTY mode", () => {
  it("returns empty string when no lastResult", () => {
    const state = makeProgressState({ total: 3 });
    expect(renderFrame(state, verboseTTY)).toBe("");
  });

  it("emits a checkmark line for a completed session", () => {
    const state = makeProgressState({ total: 3 });
    state.completed = 1;
    state.lastResult = {
      sessionId: "session-123",
      messages: 15,
      tokensBefore: 3000,
      tokensAfter: 200,
      elapsed: 700,
    };
    const output = renderFrame(state, verboseTTY);
    expect(output).toContain("✓");
    expect(output).toContain("session-123");
    expect(output).toContain("15 msgs");
  });
});

describe("renderFrame — TTY non-verbose mode", () => {
  it("returns 3 lines of output (after the overwrite prefix)", () => {
    const state = makeProgressState({ total: 10, dryRun: false });
    state.completed = 3;
    state.messagesIn = 120;
    state.tokensIn = 50000;
    state.lastResult = {
      sessionId: "agent-aabbcc",
      messages: 40,
      tokensBefore: 15000,
      elapsed: 2100,
    };
    // prevLines = 0 means first frame (no cursor-up)
    const output = renderFrame(state, ttyOpts, 0);
    const lines = output.split("\n").filter(l => l.length > 0);
    expect(lines.length).toBe(FRAME_LINES);
  });

  it("shows dry-run badge when dryRun is true", () => {
    const state = makeProgressState({ total: 5, dryRun: true });
    const output = renderFrame(state, ttyOpts, 0);
    expect(output).toContain("[dry-run]");
  });

  it("shows phase bar when phases are provided", () => {
    const state = makeProgressState({
      phases: [{ name: "Import", status: "active" }],
      total: 5,
    });
    const output = renderFrame(state, ttyOpts, 0);
    expect(output).toContain("● Import");
  });

  it("shows pending phases as hollow dots", () => {
    const state = makeProgressState({
      phases: [
        { name: "Import", status: "done" },
        { name: "Compact", status: "pending" },
      ],
      total: 5,
    });
    const output = renderFrame(state, ttyOpts, 0);
    expect(output).toContain("● Import");
    expect(output).toContain("○ Compact");
  });

  it("shows compression ratio when tokensOut > 0", () => {
    const state = makeProgressState({ total: 5 });
    state.tokensIn = 50000;
    state.tokensOut = 3000;
    const output = renderFrame(state, ttyOpts, 0);
    expect(output).toContain("×");
  });

  it("does not show ratio when tokensOut is 0", () => {
    const state = makeProgressState({ total: 5 });
    state.tokensIn = 50000;
    state.tokensOut = 0;
    const output = renderFrame(state, ttyOpts, 0);
    // Should show token count but no ratio
    expect(output).toContain("~50.0k");
    expect(output).not.toContain("×");
  });

  it("shows current session when processing", () => {
    const state = makeProgressState({ total: 5 });
    state.current = {
      sessionId: "agent-processing",
      messages: 55,
      tokens: 8000,
      startedAt: Date.now() - 500,
    };
    const output = renderFrame(state, ttyOpts, 0);
    expect(output).toContain("agent-processing");
    expect(output).toContain("processing...");
  });

  it("includes cursor-up codes when prevLines > 0", () => {
    const state = makeProgressState({ total: 5 });
    const output = renderFrame(state, ttyOpts, 3);
    // Should contain ESC[3A (cursor up 3 lines)
    expect(output).toContain("\x1b[3A");
  });
});

describe("makeProgressState", () => {
  it("initialises with sensible defaults", () => {
    const state = makeProgressState({ total: 10, dryRun: true });
    expect(state.total).toBe(10);
    expect(state.completed).toBe(0);
    expect(state.errors).toEqual([]);
    expect(state.tokensIn).toBe(0);
    expect(state.tokensOut).toBe(0);
    expect(state.dryRun).toBe(true);
    expect(state.aborted).toBe(false);
    expect(state.phases).toEqual([]);
  });

  it("accepts phases array", () => {
    const phases = [{ name: "Import", status: "active" as const }];
    const state = makeProgressState({ phases });
    expect(state.phases).toEqual(phases);
  });
});

describe("FRAME_LINES constant", () => {
  it("equals 3", () => {
    expect(FRAME_LINES).toBe(3);
  });
});
