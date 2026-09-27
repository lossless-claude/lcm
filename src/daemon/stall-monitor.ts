/** How long the event loop may stay blocked before the daemon logs `daemon.stalled`. */
export const STALL_THRESHOLD_MS = 5_000;
const TICK_MS = 1_000;

/** A blocked stretch: how far past its time the tick ran, and when the tick before it ran. */
export type Stall = { ms: number; since: number };

/**
 * Ticks on an interval and compares each tick with the one before. A blocked event
 * loop cannot log while it is blocked, so the first tick after a block reports it;
 * every other tick passes `undefined`. Returns the function that stops watching.
 */
export function watchEventLoop(thresholdMs: number, onTick: (stall: Stall | undefined) => void): () => void {
  const tickMs = Math.min(TICK_MS, thresholdMs);
  // The gap is measured on the monotonic clock, which a sleeping machine does not advance.
  let last = performance.now();
  let lastWall = Date.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = Math.round(now - last - tickMs);
    const since = lastWall;
    last = now;
    lastWall = Date.now();
    onTick(late >= thresholdMs ? { ms: late, since } : undefined);
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
