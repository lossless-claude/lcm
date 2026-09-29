import { describe, it, expect } from "vitest";
import { acquireProjectMutation, enqueue, hasBlockingProjectWork, hasQueuedProjectWork } from "../../src/daemon/project-queue.js";

describe("enqueue", () => {
  it("lets a local mutation run during an external wait and reacquires before resuming", async () => {
    const first = await acquireProjectMutation("proj-mutation");
    expect(hasBlockingProjectWork("proj-mutation")).toBe(true);
    const external = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const outside = first.yieldWhile(async () => { waiting.resolve(); await external.promise; });
    await waiting.promise;
    expect(hasBlockingProjectWork("proj-mutation")).toBe(false);
    const second = await acquireProjectMutation("proj-mutation");
    expect(hasBlockingProjectWork("proj-mutation")).toBe(true);
    let resumed = false;
    void outside.then(() => { resumed = true; });
    external.resolve();
    await Promise.resolve();
    expect(resumed).toBe(false);
    second.release();
    await outside;
    expect(resumed).toBe(true);
    first.release();
    expect(hasBlockingProjectWork("proj-mutation")).toBe(false);
  });

  it("returns the result of fn", async () => {
    const result = await enqueue("proj-result", () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("operations on the same projectId run sequentially", async () => {
    const order: number[] = [];

    // First op takes longer; second should still wait for it
    const first = enqueue("proj-seq", () =>
      new Promise<void>((resolve) => setTimeout(() => { order.push(1); resolve(); }, 50))
    );
    const second = enqueue("proj-seq", () =>
      Promise.resolve(void order.push(2))
    );

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("lets the next queued operation run during an external wait, then reenters the queue", async () => {
    const waiting = Promise.withResolvers<void>();
    const external = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = enqueue("proj-yield", async (turn) => {
      order.push("first started");
      await turn.yieldWhile(async () => { waiting.resolve(); await external.promise; });
      order.push("first resumed");
    });
    await waiting.promise;
    expect(hasQueuedProjectWork("proj-yield")).toBe(true);
    expect(hasBlockingProjectWork("proj-yield")).toBe(false);
    await enqueue("proj-yield", async () => {
      expect(hasBlockingProjectWork("proj-yield")).toBe(true);
      order.push("second completed");
    });
    expect(order).toEqual(["first started", "second completed"]);
    expect(hasBlockingProjectWork("proj-yield")).toBe(false);
    external.resolve();
    await first;
    expect(order).toEqual(["first started", "second completed", "first resumed"]);
    expect(hasQueuedProjectWork("proj-yield")).toBe(false);
    expect(hasBlockingProjectWork("proj-yield")).toBe(false);
  });

  it("operations on different projectIds run in parallel", async () => {
    const started: string[] = [];

    const a = enqueue("proj-a", () =>
      new Promise<void>((resolve) => {
        started.push("a");
        setTimeout(resolve, 50);
      })
    );
    const b = enqueue("proj-b", () =>
      new Promise<void>((resolve) => {
        started.push("b");
        setTimeout(resolve, 50);
      })
    );

    // Give both a tick to start
    await Promise.resolve();
    // Both should have started before either completes
    expect(started).toContain("a");
    expect(started).toContain("b");

    await Promise.all([a, b]);
  });

  it("a failed operation does not block subsequent operations on the same project", async () => {
    const projectId = "proj-fail";

    const failing = enqueue(projectId, () => Promise.reject(new Error("boom")));
    const subsequent = enqueue(projectId, () => Promise.resolve("ok"));

    // The failing promise rejects…
    await expect(failing).rejects.toThrow("boom");
    // …but the subsequent one still resolves
    await expect(subsequent).resolves.toBe("ok");
  });

  it("queue cleans up after all operations complete", async () => {
    const projectId = "proj-cleanup";

    const op1 = enqueue(projectId, () => Promise.resolve(1));
    const op2 = enqueue(projectId, () => Promise.resolve(2));

    await Promise.all([op1, op2]);

    // After all ops complete, a new enqueue should still work correctly,
    // meaning the queue entry was removed and re-created fresh.
    const result = await enqueue(projectId, () => Promise.resolve("fresh"));
    expect(result).toBe("fresh");
  });

  it("propagates rejection from fn to the caller", async () => {
    const err = new Error("test-error");
    await expect(
      enqueue("proj-reject", () => Promise.reject(err))
    ).rejects.toThrow("test-error");
  });
});
