import { randomUUID } from "node:crypto";

export type SummarizeJob = {
  id: string; session_id: string; kind: "leaf" | "condensed"; depth: number;
  system: string; prompt: string; targetTokens: number; maxTokens: number; createdAt: number;
};
export type JobAnswer = {
  text?: string; error?: string; providerId?: "session:haiku" | "session:fork";
  usage?: { input_tokens: number; output_tokens: number; estimated: boolean };
};
type Entry = {
  job: SummarizeJob; state: "queued" | "claimed" | "done" | "failed" | "expired";
  resolve: (answer: JobAnswer) => void; timer: ReturnType<typeof setTimeout>;
};

/** Process-local FIFO. Deadlines include time spent waiting to be claimed. */
export class SummarizeJobStore {
  private jobs = new Map<string, Entry>();
  private queues = new Map<string, string[]>();
  private waiters = new Map<string, (job: SummarizeJob | null) => void>();

  constructor(private deadlineMs = 20_000, private holdMs = 25_000, private retentionMs = 60_000) {}

  enqueue(input: Omit<SummarizeJob, "id" | "createdAt">): Promise<JobAnswer> {
    const job = { ...input, id: randomUUID(), createdAt: Date.now() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(job.id, { error: "job timeout" }, "expired"), this.deadlineMs);
      timer.unref();
      this.jobs.set(job.id, { job, resolve, timer, state: "queued" });
      const queue = this.queues.get(job.session_id) ?? [];
      queue.push(job.id);
      this.queues.set(job.session_id, queue);
      const waiter = this.waiters.get(job.session_id);
      if (waiter) waiter(this.claim(job.session_id));
    });
  }

  private claim(sessionId: string): SummarizeJob | null {
    const queue = this.queues.get(sessionId);
    while (queue?.length) {
      const entry = this.jobs.get(queue.shift()!);
      if (!queue.length) this.queues.delete(sessionId);
      if (entry?.state === "queued") {
        entry.state = "claimed";
        return entry.job;
      }
    }
    return null;
  }

  next(sessionId: string, signal?: AbortSignal, wait = true): Promise<SummarizeJob | null> {
    this.waiters.get(sessionId)?.(null);
    if (signal?.aborted) return Promise.resolve(null);
    const job = this.claim(sessionId);
    if (job || !wait) return Promise.resolve(job);
    return new Promise((resolve) => {
      const finish = (job: SummarizeJob | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.waiters.get(sessionId) === finish) this.waiters.delete(sessionId);
        resolve(job);
      };
      const abort = () => finish(null);
      const timer = setTimeout(abort, this.holdMs);
      timer.unref();
      this.waiters.set(sessionId, finish);
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
    const queue = this.queues.get(entry.job.session_id)?.filter((queued) => queued !== id);
    if (queue?.length) this.queues.set(entry.job.session_id, queue);
    else this.queues.delete(entry.job.session_id);
    entry.resolve(answer);
    entry.timer = setTimeout(() => this.jobs.delete(id), this.retentionMs);
    entry.timer.unref();
  }

  close(): void {
    for (const waiter of this.waiters.values()) waiter(null);
    for (const entry of this.jobs.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ error: "daemon stopped" });
    }
    this.jobs.clear();
    this.queues.clear();
  }
}
