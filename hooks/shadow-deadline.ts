import type { EngineInterface, Timer } from "claude-code";

export const SHADOW_WAIT_MS = 2000;
export class ShadowInterrupted extends Error {
  constructor(readonly outcome: "unavailable" | "cancelled") { super(outcome); }
}

/** One operation-wide deadline; late prerequisites cannot start another stage. */
export class ShadowDeadline {
  private closed = false;
  private interruption?: ShadowInterrupted;
  private reject!: (error: ShadowInterrupted) => void;
  private readonly stopped = new Promise<never>((_resolve, reject) => { this.reject = reject; });
  private readonly expiresAt = Date.now() + SHADOW_WAIT_MS;
  private readonly timer: Timer;
  private readonly abort = () => this.stop("cancelled");
  constructor(clock: Pick<EngineInterface["clock"], "after">, private readonly signal?: AbortSignal) {
    void this.stopped.catch(() => {});
    this.timer = clock.after(SHADOW_WAIT_MS, () => this.stop("unavailable"));
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  check(): void {
    if (Date.now() >= this.expiresAt) this.stop("unavailable");
    if (this.interruption) throw this.interruption;
    if (this.closed) throw new ShadowInterrupted("unavailable");
  }
  wait<T>(work: Promise<T>): Promise<T> { return Promise.race([work, this.stopped]); }
  close(): void {
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    try { this.timer.cancel(); } catch { /* Cleanup never replaces native. */ }
  }
  private stop(outcome: ShadowInterrupted["outcome"]): void {
    if (this.closed || this.interruption) return;
    this.interruption = new ShadowInterrupted(outcome); this.reject(this.interruption);
  }
}
