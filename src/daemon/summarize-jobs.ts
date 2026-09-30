import { randomUUID } from "node:crypto";

export type SummarizeJob = {
  id: string; session_id: string; kind: "leaf" | "condensed"; depth: number;
  system: string; prompt: string; targetTokens: number; maxTokens: number; createdAt: number;
  /** Only dedicated workers may claim these jobs. */
  pool?: true;
};
export type SummaryProviderId = "session:haiku" | "session:fork" | "session-pool:haiku" | "session-pool:sonnet";
export type JobAnswer = {
  text?: string; error?: string; providerId?: SummaryProviderId;
  usage?: { input_tokens: number; output_tokens: number; estimated: boolean };
  /** Attempts that spent tokens before the final answer or error. */
  usageAttempts?: Array<{
    providerId: SummaryProviderId;
    usage: { input_tokens: number; output_tokens: number; estimated: boolean };
    failed?: boolean;
  }>;
};
type Entry = {
  job: SummarizeJob; state: "queued" | "claimed" | "done" | "failed" | "expired";
  resolve: (answer: JobAnswer) => void; timer: ReturnType<typeof setTimeout>;
  workerId?: string;
};

/** How long a worker has to answer a pool job once claimed; replay chunks take a model longer than a claim. */
export const POOL_COMPLETION_MS = 180_000;

/** Leaf answers need more than the claim window; leave room within the 120-second PreCompact bound. */
export const SESSION_COMPLETION_MS = 60_000;

/**
 * Process-local FIFO. Jobs have a claim window, then a separate completion deadline
 * for the session or pool provider.
 */
export class SummarizeJobStore {
  private jobs = new Map<string, Entry>();
  private queues = new Map<string, string[]>();
  private waiters = new Map<string, (job: SummarizeJob | null) => void>();
  private activeWorkers = new Map<string, string>();

  constructor(
    private deadlineMs = 20_000, private holdMs = 25_000, private retentionMs = 60_000,
    private poolCompletionMs = POOL_COMPLETION_MS,
    private sessionCompletionMs = SESSION_COMPLETION_MS,
  ) {}

  enqueue(input: Omit<SummarizeJob, "id" | "createdAt">): Promise<JobAnswer> {
    const job = { ...input, id: randomUUID(), createdAt: Date.now() };
    return new Promise((resolve) => {
      const timer = this.expireAfter(job.id, this.deadlineMs);
      this.jobs.set(job.id, { job, resolve, timer, state: "queued" });
      const key = job.pool ? "pool" : `session:${job.session_id}`;
      const queue = this.queues.get(key) ?? [];
      queue.push(job.id);
      this.queues.set(key, queue);
      if (job.pool) this.wakeWorkers();
      else this.waiters.get(key)?.(this.claim(key));
    });
  }

  private claim(key: string, workerId?: string): SummarizeJob | null {
    if (workerId && this.activeWorkers.has(workerId)) return null;
    const queue = this.queues.get(key);
    while (queue?.length) {
      const entry = this.jobs.get(queue.shift()!);
      if (!queue.length) this.queues.delete(key);
      if (entry?.state === "queued") {
        entry.state = "claimed";
        if (workerId) {
          entry.workerId = workerId;
          this.activeWorkers.set(workerId, entry.job.id);
        }
        clearTimeout(entry.timer);
        entry.timer = this.expireAfter(entry.job.id, entry.job.pool ? this.poolCompletionMs : this.sessionCompletionMs);
        return entry.job;
      }
    }
    return null;
  }

  private expireAfter(id: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.finish(id, { error: "job timeout" }, "expired"), ms);
    timer.unref();
    return timer;
  }

  next(sessionId: string, signal?: AbortSignal, wait = true): Promise<SummarizeJob | null> {
    return this.poll(`session:${sessionId}`, `session:${sessionId}`, signal, wait);
  }

  nextWorker(workerId: string, signal?: AbortSignal, wait = true): Promise<SummarizeJob | null> {
    return this.poll(`worker:${workerId}`, "pool", signal, wait, workerId);
  }

  private wakeWorkers(): void {
    for (const [key, waiter] of this.waiters) {
      if (!key.startsWith("worker:")) continue;
      const job = this.claim("pool", key.slice("worker:".length));
      if (job) waiter(job);
    }
  }

  private poll(key: string, queue: string, signal: AbortSignal | undefined, wait: boolean, workerId?: string): Promise<SummarizeJob | null> {
    this.waiters.get(key)?.(null);
    if (signal?.aborted) return Promise.resolve(null);
    const job = this.claim(queue, workerId);
    if (job || !wait) return Promise.resolve(job);
    return new Promise((resolve) => {
      const finish = (job: SummarizeJob | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.waiters.get(key) === finish) this.waiters.delete(key);
        resolve(job);
      };
      const abort = () => finish(null);
      const timer = setTimeout(abort, this.holdMs);
      timer.unref();
      this.waiters.set(key, finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  answer(id: string, answer: JobAnswer): "accepted" | "discarded" | "missing" {
    const entry = this.jobs.get(id);
    if (!entry) return "missing";
    if (entry.state !== "claimed") return "discarded";
    this.finish(id, answer, answer.error ? "failed" : "done");
    return "accepted";
  }

  private finish(id: string, answer: JobAnswer, state: Entry["state"]): void {
    const entry = this.jobs.get(id);
    if (!entry || (entry.state !== "queued" && entry.state !== "claimed")) return;
    clearTimeout(entry.timer);
    entry.state = state;
    const key = entry.job.pool ? "pool" : `session:${entry.job.session_id}`;
    const queue = this.queues.get(key)?.filter((queued) => queued !== id);
    if (queue?.length) this.queues.set(key, queue);
    else this.queues.delete(key);
    if (entry.workerId) this.activeWorkers.delete(entry.workerId);
    entry.resolve(answer);
    entry.timer = setTimeout(() => this.jobs.delete(id), this.retentionMs);
    entry.timer.unref();
    if (entry.job.pool) this.wakeWorkers();
  }

  close(): void {
    for (const waiter of this.waiters.values()) waiter(null);
    for (const entry of this.jobs.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ error: "daemon stopped" });
    }
    this.jobs.clear();
    this.queues.clear();
    this.activeWorkers.clear();
  }
}
