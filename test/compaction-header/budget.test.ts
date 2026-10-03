import { describe, expect, it } from "vitest";
import { sessionOutputBudget } from "../../hooks/model-budget.js";

describe("session model output budget", () => {
  it.each([NaN, undefined, Infinity, -1, 1.5, 1e18])("treats invalid host output %s as unknown and releases its bounded lease", async output => {
    const budget = sessionOutputBudget({}, "invalid-host", 20);
    const failed = await budget.reserveComplete(6), concurrent = await budget.reserveComplete(5);
    const later = budget.reserveOrdinary(2, false);
    expect(() => failed!.settle(output as number)).not.toThrow();
    expect(budget.snapshot()).toMatchObject({ spent: 6, reserved: 5, usageUnknown: true });
    concurrent!.settle(2);
    const next = await later;
    expect(next?.maxTokens).toBe(2);
    next!.settle(1);
    expect(budget.snapshot()).toMatchObject({ spent: 9, reserved: 0, available: 11 });
  });
  it("releases an invalid fork lease so a queued completion cannot hang", async () => {
    const budget = sessionOutputBudget({}, "invalid-fork", 10), fork = budget.reserveFork();
    const later = budget.reserveComplete(2);
    expect(() => fork!.settle(NaN)).not.toThrow();
    expect(await later).toBeNull();
    expect(budget.snapshot()).toMatchObject({ spent: 10, unbounded: false, usageUnknown: true });
  });
  it("spends an unknown lease at its reservation while preserving other concurrent allowances", async () => {
    const budget = sessionOutputBudget({}, "concurrent", 20);
    const failed = await budget.reserveComplete(6), other = await budget.reserveComplete(5);
    failed!.settle(null);
    expect(budget.snapshot()).toMatchObject({ usageUnknown: true, spent: 6, reserved: 5, available: 9 });
    other!.settle(2);
    expect(budget.snapshot()).toMatchObject({ spent: 8, reserved: 0, available: 12 });
    expect((await budget.reserveComplete(100))!.maxTokens).toBe(12);
  });
  it("reserves allowance and charges actual output, releasing unused tokens", async () => {
    const budget = sessionOutputBudget({}, "session-a", 10);
    const lease = await budget.reserveComplete(8);
    expect(lease?.maxTokens).toBe(8);
    expect(budget.snapshot()).toMatchObject({ spent: 0, reserved: 8, available: 2 });
    lease!.settle(3);
    expect(budget.snapshot()).toMatchObject({ spent: 3, reserved: 0, available: 7 });
    expect(() => lease!.settle(3)).toThrow("settled");
  });
  it("reserves equal allowances atomically for B/C while another completion is pending", async () => {
    const budget = sessionOutputBudget({}, "session-a", 11);
    const ordinary = await budget.reserveComplete(3);
    const pair = await budget.reserveComplete(9, 2);
    expect(pair?.maxTokens).toBe(4);
    expect(await budget.reserveComplete(1)).toBeNull();
    ordinary!.settle(2); pair!.settle(5);
    expect(budget.snapshot()).toMatchObject({ spent: 7, available: 4, reserved: 0 });
  });
  it("blocks bounded admissions behind an uncapped fork and records its unavoidable overshoot", async () => {
    const budget = sessionOutputBudget({}, "session-a", 5);
    const fork = budget.reserveFork(); expect(fork).not.toBeNull();
    let admitted = false;
    const completion = budget.reserveComplete(3).then(lease => { admitted = true; return lease; });
    await Promise.resolve(); expect(admitted).toBe(false);
    fork!.settle(8);
    expect(await completion).toBeNull();
    expect(budget.snapshot()).toMatchObject({ spent: 8, overshoot: 3, available: 0 });
  });
  it("does not defer a cut-time fork behind an existing request", async () => {
    const budget = sessionOutputBudget({}, "session-a", 10);
    const ordinary = await budget.reserveComplete(3);
    expect(budget.reserveFork()).toBeNull();
    ordinary!.settle(1);
    expect(budget.reserveFork()).not.toBeNull();
  });
  it("preserves spending across owner reuse and separates changed sessions and owners", async () => {
    const owner = {}, budget = sessionOutputBudget(owner, "a", 10);
    (await budget.reserveComplete(4))!.settle(4);
    expect(sessionOutputBudget(owner, "a", 10)).toBe(budget);
    expect(sessionOutputBudget(owner, "a", 10).snapshot().spent).toBe(4);
    expect(sessionOutputBudget(owner, "b", 10).snapshot().spent).toBe(0);
    expect(sessionOutputBudget({}, "a", 10).snapshot().spent).toBe(0);
  });
  it("charges unavailable usage conservatively while allowing only the remaining budget", async () => {
    const budget = sessionOutputBudget({}, "a", 10);
    (await budget.reserveComplete(4))!.settle(null);
    expect(budget.snapshot()).toMatchObject({ usageUnknown: true, spent: 4, available: 6 });
    expect((await budget.reserveComplete(1))!.maxTokens).toBe(1);
    expect(budget.reserveFork()).toBeNull();
  });
  it.each([0, 1])("refuses a pair when the shared cap is %i without spending", async cap => {
    const budget = sessionOutputBudget({}, "a", cap);
    expect(await budget.reserveComplete(10, 2)).toBeNull();
    expect(budget.snapshot().spent).toBe(0);
  });
});
