import { beforeEach, describe, expect, it, vi } from "vitest";

const CAP = 10;

async function modules() {
  const model = await import("../../hooks/model-budget.js");
  const shadow = await import("../../hooks/shadow-budget.js");
  return { ...model, ...shadow };
}

describe("per-session budget pruning", () => {
  beforeEach(() => vi.resetModules());

  it("keeps only live sessions after several sessions pass through one module instance", async () => {
    const m = await modules();
    for (const id of ["a", "b", "c", "d"]) { m.sharedSessionOutputBudget(id, CAP); m.shadowSessionOutputBudget(id, CAP); }
    for (const id of ["a", "b", "c"]) { m.endSharedSessionBudget(id); m.endShadowSessionBudget(id); }
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual(["d"]);
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual(["d"]);
  });

  it("starts a later event for an ended session from a fresh entry", async () => {
    const m = await modules();
    (await m.sharedSessionOutputBudget("a", CAP).reserveComplete(4))!.settle(4);
    m.endSharedSessionBudget("a");
    expect(m.sharedSessionOutputBudget("a", CAP).snapshot().spent).toBe(0);
  });

  it("ignores the end of a session that never had a budget", async () => {
    const m = await modules();
    expect(() => { m.endSharedSessionBudget("none"); m.endShadowSessionBudget("none"); }).not.toThrow();
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual([]);
  });

  it.each([
    ["a bounded lease", (budget: any) => budget.reserveComplete(4)],
    ["a fork lease", (budget: any) => budget.reserveFork()],
  ])("keeps the entry of an ended session until %s settles", async (_name, take) => {
    const m = await modules();
    const budget = m.sharedSessionOutputBudget("a", CAP), lease = await take(budget);
    m.endSharedSessionBudget("a");
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual(["a"]);
    expect(m.sharedSessionOutputBudget("a", CAP)).toBe(budget);
    m.endSharedSessionBudget("a");
    lease.settle(2);
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual([]);
    expect(m.sharedSessionOutputBudget("a", CAP)).not.toBe(budget);
  });

  it("does not hand out a second cap while a lease is in flight", async () => {
    const m = await modules();
    const lease = (await m.sharedSessionOutputBudget("a", CAP).reserveComplete(CAP))!;
    m.endSharedSessionBudget("a");
    expect(m.sharedSessionOutputBudget("a", CAP).snapshot()).toMatchObject({ reserved: CAP, available: 0 });
    lease.settle(CAP);
  });

  it("keeps the entry for a waiting reservation that takes a lease once the holder settles", async () => {
    const m = await modules();
    const budget = m.sharedSessionOutputBudget("a", CAP), holder = (await budget.reserveComplete(4))!;
    const waiter = budget.reserveExclusive();
    m.endSharedSessionBudget("a");
    holder.settle(1);
    const lease = (await waiter)!;
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual(["a"]);
    lease.settle(1);
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual([]);
  });

  it("drops the entry once a waiting reservation finds nothing to lease", async () => {
    const m = await modules();
    const budget = m.sharedSessionOutputBudget("a", CAP), fork = budget.reserveFork()!;
    const waiter = budget.reserveComplete(2);
    m.endSharedSessionBudget("a");
    fork.settle(CAP);
    expect(await waiter).toBeNull();
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual([]);
  });

  it("lets background work keep spending on the budget it holds after the entry is gone", async () => {
    const m = await modules();
    const held = m.shadowSessionOutputBudget("a", CAP);
    m.endShadowSessionBudget("a");
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual([]);
    const lease = (await held.reserveComplete(3))!;
    lease.settle(3);
    expect(held.snapshot()).toMatchObject({ spent: 3, reserved: 0 });
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual([]);
  });

  it("prunes a shadow entry only after its pending arm settles", async () => {
    const m = await modules();
    const lease = m.shadowSessionOutputBudget("a", CAP).reserveFork()!;
    m.endShadowSessionBudget("a");
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual(["a"]);
    lease.settle(1);
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual([]);
  });

  it("keeps the entry when the same id is used again before its lease settles", async () => {
    const m = await modules();
    const budget = m.sharedSessionOutputBudget("a", CAP), lease = (await budget.reserveComplete(4))!;
    m.endSharedSessionBudget("a");
    m.sharedSessionOutputBudget("a", CAP);
    lease.settle(4);
    expect(m.sharedSessionOutputBudget("a", CAP)).toBe(budget);
  });

  it("prunes both maps when the module receives session.end", async () => {
    const m = await modules();
    const handlers = new Map<string, (...args: any[]) => any>();
    const { register } = await import("../../hooks/lcm-hooks.js");
    register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
    for (const id of ["a", "b", "c"]) { m.sharedSessionOutputBudget(id, CAP); m.shadowSessionOutputBudget(id, CAP); }
    const engine = { fs: { write: vi.fn(async () => undefined) }, process: { run: vi.fn(async () => ({ stdout: "", exitCode: 0 })) }, ui: { log: vi.fn() } };
    for (const sessionId of ["a", "b"]) await handlers.get("session.end")!(engine, { sessionId, reason: "clear" }, vi.fn((event) => event));
    expect(m._sharedSessionBudgetIdsForTesting()).toEqual(["c"]);
    expect(m._shadowSessionBudgetIdsForTesting()).toEqual(["c"]);
  });
});
