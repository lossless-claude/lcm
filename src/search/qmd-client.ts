import { Worker } from 'node:worker_threads';
import type { QmdIndexRequest, QmdIndexResult, QmdSearchRequest, QmdSearchResult, QmdTask, QmdReply } from './qmd-protocol.js';
export type { QmdIndexRequest, QmdIndexResult, QmdSearchRequest, QmdSearchResult } from './qmd-protocol.js';

export interface QmdWorker {
  postMessage(task: QmdTask): void;
  on(event: 'message', listener: (reply: QmdReply) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}
export type QmdClientOptions = {
  workerFactory?: () => QmdWorker;
  searchTimeoutMs?: number; hybridTimeoutMs?: number; indexTimeoutMs?: number;
};
type Pending = { task: QmdTask; resolve: (value: QmdIndexResult | QmdSearchResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export interface QmdClient {
  index(request: QmdIndexRequest): Promise<QmdIndexResult>;
  search(request: QmdSearchRequest): Promise<QmdSearchResult>;
  close(): Promise<void>;
}

/** Keeps QMD native SQLite and model work off the daemon event loop. */
export function createQmdClient(options: QmdClientOptions = {}): QmdClient {
  let worker: QmdWorker | undefined;
  let closed = false;
  let nextId = 0;
  let activeId: number | undefined;
  const pending = new Map<number, Pending>();

  function rejectPending(error: Error): void {
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
    activeId = undefined;
  }
  function retire(instance: QmdWorker, error: Error): void {
    if (worker !== instance) return;
    worker = undefined;
    rejectPending(error);
    void instance.terminate().catch(() => undefined);
  }
  function ensureWorker(): QmdWorker {
    if (worker) return worker;
    const instance: QmdWorker = options.workerFactory?.() ?? new Worker(new URL('./qmd-worker.js', import.meta.url));
    worker = instance;
    instance.on('message', (reply) => {
      if (worker !== instance) return;
      const task = pending.get(reply.id);
      if (!task || activeId !== reply.id) return;
      clearTimeout(task.timer);
      pending.delete(reply.id);
      activeId = undefined;
      if (reply.ok) task.resolve(reply.result);
      else task.reject(new Error(reply.error));
      startNext();
    });
    instance.on('error', () => retire(instance, new Error('QMD worker failed; retry the operation.')));
    instance.on('exit', (code) => retire(instance, new Error(`QMD worker exited (${code}); retry the operation.`)));
    return instance;
  }
  function startNext(): void {
    if (closed || activeId !== undefined) return;
    const next = pending.values().next().value as Pending | undefined;
    if (!next) return;
    activeId = next.task.id;
    let instance: QmdWorker;
    try { instance = ensureWorker(); }
    catch { rejectPending(new Error('Could not start QMD worker.')); return; }
    try { instance.postMessage(next.task); }
    catch { retire(instance, new Error('Could not send operation to QMD worker.')); }
  }
  function expire(id: number): void {
    const entry = pending.get(id);
    if (!entry) return;
    if (id === activeId && worker) {
      retire(worker, new Error('Active QMD operation timed out; retry or rebuild the index.'));
      return;
    }
    pending.delete(id);
    entry.reject(new Error('QMD queue wait timed out; retry after the current operation finishes.'));
  }
  function dispatch(task: QmdTask, timeout: number): Promise<QmdIndexResult | QmdSearchResult> {
    if (closed) return Promise.reject(new Error('QMD client is closed.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => expire(task.id), timeout);
      pending.set(task.id, { task, resolve, reject, timer });
      startNext();
    });
  }
  return {
    index: (request) => dispatch({ id: ++nextId, operation: 'index', request }, request.timeoutMs ?? options.indexTimeoutMs ?? 600_000) as Promise<QmdIndexResult>,
    search: (request) => dispatch({ id: ++nextId, operation: 'search', request }, request.mode === 'hybrid' ? options.hybridTimeoutMs ?? 120_000 : options.searchTimeoutMs ?? 10_000) as Promise<QmdSearchResult>,
    async close() {
      closed = true;
      const instance = worker;
      worker = undefined;
      rejectPending(new Error('QMD client is closed.'));
      if (instance) await instance.terminate();
    },
  };
}
