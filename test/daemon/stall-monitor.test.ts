import { describe, it, expect, vi, afterEach } from "vitest";
import { watchEventLoop } from "../../src/daemon/stall-monitor.js";

describe("watchEventLoop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the full elapsed gap since the previous tick, not the gap minus one tick interval", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let tick: () => void = () => {};
    vi.spyOn(global, "setInterval").mockImplementation(((cb: () => void) => {
      tick = cb;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval);
    vi.spyOn(global, "clearInterval").mockImplementation(() => {});

    const ticks: Array<{ ms: number; since: number } | undefined> = [];
    const stop = watchEventLoop(5_000, (stall) => ticks.push(stall));

    // First tick fires exactly on schedule (the 1s cadence): no stall.
    now = 1_000;
    tick();
    expect(ticks.at(-1)).toBeUndefined();

    // The event loop blocks for 5.1s starting right after that tick: the next tick,
    // due at 2_000, cannot run until the block ends at 6_100. The documented ">5s
    // stall" refers to that whole 5.1s gap, which must clear the 5_000ms threshold.
    now = 6_100;
    tick();

    stop();
    const stall = ticks.at(-1);
    expect(stall).toBeDefined();
    expect(stall!.ms).toBeGreaterThanOrEqual(5_000);
    expect(stall!.ms).toBe(5_100);
  });

  it("does not report a stall for a tick that fires on schedule", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let tick: () => void = () => {};
    vi.spyOn(global, "setInterval").mockImplementation(((cb: () => void) => {
      tick = cb;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval);
    vi.spyOn(global, "clearInterval").mockImplementation(() => {});

    const ticks: Array<{ ms: number; since: number } | undefined> = [];
    const stop = watchEventLoop(5_000, (stall) => ticks.push(stall));

    now = 1_000;
    tick();
    now = 2_000;
    tick();

    stop();
    expect(ticks.every((s) => s === undefined)).toBe(true);
  });
});
