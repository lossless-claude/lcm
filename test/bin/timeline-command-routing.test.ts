import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerTimelineCommands } from "../../src/cli/timeline.js";

afterEach(() => vi.restoreAllMocks());
it("routes a zero-call settle to the daemon and rejects an invalid call budget", async () => {
  const post = vi.fn(async () => ({ generated: 0, pending: 1, stale: 0, calls: 0, stopped: "budget", failed: [] }));
  const createDaemonClientOrExit = vi.fn(async () => ({ post }));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const program = new Command();
  registerTimelineCommands(program, { createDaemonClientOrExit } as never);
  await program.parseAsync(["timeline", "settle", "--calls", "0"], { from: "user" });
  expect(post).toHaveBeenCalledWith("/timeline", { cwd: process.cwd(), calls: 0 });
  const invalid = new Command();
  registerTimelineCommands(invalid, { createDaemonClientOrExit } as never);
  await expect(invalid.parseAsync(["timeline", "settle", "--calls", "-1"], { from: "user" })).rejects.toThrow("non-negative");
  expect(createDaemonClientOrExit).toHaveBeenCalledTimes(1);
});


it("routes explicit full reconciliation without a model-call budget", async () => {
  const post = vi.fn(async () => ({ generated: 0, pending: 1, stale: 0, calls: 0, stopped: "budget", failed: [] }));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const program = new Command().exitOverride();
  registerTimelineCommands(program, { createDaemonClientOrExit: async () => ({ post }) } as never);
  await program.parseAsync(["timeline", "settle", "--calls", "0", "--reconcile", "full"], { from: "user" });
  expect(post).toHaveBeenCalledWith("/timeline", { cwd: process.cwd(), calls: 0, reconcile: "full" });
});

it("prints a provider-admission configuration error verbatim", async () => {
  const message = "Timeline provider chain requires bounded HTTP admission: configure every provider and fallback as a named openai or anthropic endpoint with maxConcurrent";
  const post = vi.fn(async () => { throw Object.assign(new Error(message), { status: 409 }); });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const previous = process.exitCode;
  const program = new Command();
  registerTimelineCommands(program, { createDaemonClientOrExit: async () => ({ post }) } as never);
  try {
    await program.parseAsync(["timeline", "settle"], { from: "user" });
    expect(stderr).toHaveBeenCalledExactlyOnceWith(message + "\n");
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = previous; }
});


it("routes teardown node removal explicitly and preserves the default", async () => {
  const post = vi.fn(async () => ({}));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const program = new Command().exitOverride();
  registerTimelineCommands(program, { createDaemonClientOrExit: async () => ({ post }) } as never);
  await program.parseAsync(["timeline", "teardown"], { from: "user" });
  expect(post).toHaveBeenLastCalledWith("/timeline", { cwd: process.cwd(), action: "teardown", calls: 0 });
  await program.parseAsync(["timeline", "teardown", "--remove-nodes"], { from: "user" });
  expect(post).toHaveBeenLastCalledWith("/timeline", { cwd: process.cwd(), action: "teardown", calls: 0, removeNodes: true });
});
