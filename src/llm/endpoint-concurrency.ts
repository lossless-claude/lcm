type Waiter = { resolve: () => void; timer?: ReturnType<typeof setTimeout> };
type Semaphore = { limit: number; active: number; live: Waiter[]; background: Waiter[] };

// Named endpoints are daemon-wide resources even when callers build separate summarizers.
const semaphores = new Map<string, Semaphore>();

/** Live goes first; only live slot waits expire. The request gets its own deadline. */
export async function withEndpointSlot<T>(
  name: string, maxConcurrent: number | undefined, waitMs: number, request: () => Promise<T>,
  workClass: "live" | "background" = "live",
): Promise<T> {
  if (maxConcurrent === undefined) return request();
  let semaphore = semaphores.get(name);
  if (!semaphore) {
    semaphore = { limit: maxConcurrent, active: 0, live: [], background: [] };
    semaphores.set(name, semaphore);
  }
  const gate = semaphore;
  const waiting = gate[workClass];
  if (gate.active < gate.limit && gate.live.length === 0 && gate.background.length === 0) {
    gate.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve };
      if (workClass === "live") waiter.timer = setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index < 0) return;
        waiting.splice(index, 1);
        const error = new Error(`wait for endpoint ${name} slot timed out after ${waitMs}ms`);
        error.name = "APIConnectionTimeoutError";
        reject(error);
      }, waitMs);
      waiting.push(waiter);
    });
  }
  try {
    return await request();
  } finally {
    const next = gate.live.shift() ?? gate.background.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      gate.active--;
      if (gate.active === 0) semaphores.delete(name);
    }
  }
}
