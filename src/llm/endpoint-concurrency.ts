type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Semaphore = { limit: number; active: number; waiting: Waiter[] };

// Named endpoints are daemon-wide resources even when callers build separate summarizers.
const semaphores = new Map<string, Semaphore>();

/** Wait at most one request deadline for a slot, then give the request a fresh deadline. */
export async function withEndpointSlot<T>(
  name: string, maxConcurrent: number | undefined, waitMs: number, request: () => Promise<T>,
): Promise<T> {
  if (maxConcurrent === undefined) return request();
  let semaphore = semaphores.get(name);
  if (!semaphore) {
    semaphore = { limit: maxConcurrent, active: 0, waiting: [] };
    semaphores.set(name, semaphore);
  }
  const gate = semaphore;
  if (gate.active < gate.limit && gate.waiting.length === 0) {
    gate.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        const index = gate.waiting.indexOf(waiter);
        if (index < 0) return;
        gate.waiting.splice(index, 1);
        const error = new Error(`wait for endpoint ${name} slot timed out after ${waitMs}ms`);
        error.name = "APIConnectionTimeoutError";
        reject(error);
      }, waitMs) };
      gate.waiting.push(waiter);
    });
  }
  try {
    return await request();
  } finally {
    const next = gate.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      gate.active--;
      if (gate.active === 0) semaphores.delete(name);
    }
  }
}
