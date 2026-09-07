import { describe, it, expect, vi, afterEach } from "vitest";
import { NinjaRenderer } from "../src/cli/pipeline-runner.js";
import { makeProgressState } from "../src/cli/progress-state.js";
import type { RenderOpts } from "../src/cli/render-frame.js";

const nonTTY: RenderOpts = { isTTY: false, width: 80, color: false, verbose: false };

describe("NinjaRenderer signal handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRenderer(): NinjaRenderer {
    const state = makeProgressState({ total: 3 });
    return new NinjaRenderer({ state, renderOpts: { ...nonTTY } });
  }

  it("registers SIGINT and SIGTERM handlers on start and removes them on stop", () => {
    const onSpy = vi.spyOn(process, "on");
    const removeSpy = vi.spyOn(process, "removeListener");
    const renderer = makeRenderer();

    renderer.start();
    const registered = onSpy.mock.calls.map((c) => c[0]);
    expect(registered).toContain("SIGINT");
    expect(registered).toContain("SIGTERM");
    expect(registered).toContain("SIGWINCH");

    renderer.stop();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain("SIGINT");
    expect(removed).toContain("SIGTERM");
    expect(removed).toContain("SIGWINCH");
  });

  it("SIGINT waits for in-flight work before exiting", async () => {
    const renderer = makeRenderer();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderer.start();

    const release = renderer.trackInFlight();

    // Fire SIGINT while work is in flight
    process.emit("SIGINT");
    expect(renderer.shouldStop).toBe(true);
    // Must not exit while in-flight work is pending
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).not.toHaveBeenCalled();

    // Once the in-flight work settles, the runner exits with 130
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(130);
    renderer.stop();
  });

  it("a second SIGINT exits immediately without waiting for in-flight work", async () => {
    const renderer = makeRenderer();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderer.start();

    const release = renderer.trackInFlight();

    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).not.toHaveBeenCalled();

    // The work is hung; a second signal must not wait for it
    process.emit("SIGINT");
    expect(exitSpy).toHaveBeenCalledWith(130);

    release();
    renderer.stop();
  });

  it("SIGTERM exits with 143 after in-flight work drains", async () => {
    const renderer = makeRenderer();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderer.start();

    const release = renderer.trackInFlight();
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(143);
    renderer.stop();
  });

  it("SIGINT with no in-flight work exits promptly", async () => {
    const renderer = makeRenderer();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderer.start();

    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(130);
    renderer.stop();
  });

  it("trackInFlight releases multiple waiters in order", async () => {
    const renderer = makeRenderer();
    const release1 = renderer.trackInFlight();
    const release2 = renderer.trackInFlight();
    expect(renderer.shouldStop).toBe(false);
    release1();
    release2();
    // No hang, no drain waiter leaked
    expect(renderer.shouldStop).toBe(false);
  });
});
