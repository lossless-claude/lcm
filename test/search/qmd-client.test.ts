import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQmdClient, type QmdClient, type QmdWorker } from '../../src/search/qmd-client.js';
import type { QmdTask } from '../../src/search/qmd-protocol.js';

class FakeWorker extends EventEmitter {
  tasks: QmdTask[] = [];
  postMessage(task: QmdTask) { this.tasks.push(task); }
  terminate = vi.fn(async () => 0);
}
const clients: QmdClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.useRealTimers();
});
function setup(options: Parameters<typeof createQmdClient>[0] = {}) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker as QmdWorker; });
  const client = createQmdClient({ ...options, workerFactory: factory });
  clients.push(client);
  return { client, workers, factory };
}

describe('QMD worker client', () => {
  it('starts lazily and posts queued work only when active work completes', async () => {
    const { client, workers, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    const first = client.search({ cwd: '/project', query: 'first' });
    const second = client.index({ cwd: '/project', embed: false });
    expect(factory).toHaveBeenCalledTimes(1);
    const worker = workers[0];
    expect(worker.tasks).toHaveLength(1);
    worker.emit('message', { id: worker.tasks[0].id, ok: true, result: { matches: [] } });
    expect(worker.tasks).toHaveLength(2);
    worker.emit('message', { id: worker.tasks[1].id, ok: true, result: { documents: 2 } });
    await expect(first).resolves.toEqual({ matches: [] });
    await expect(second).resolves.toEqual({ documents: 2 });
  });
  it('propagates task errors while keeping the worker usable', async () => {
    const { client, workers, factory } = setup();
    const failed = client.search({ cwd: '/project', query: 'missing' });
    workers[0].emit('message', { id: 1, ok: false, error: 'QMD index is not ready.' });
    await expect(failed).rejects.toThrow('index is not ready');
    const next = client.search({ cwd: '/project', query: 'retry' });
    workers[0].emit('message', { id: 2, ok: true, result: { matches: [] } });
    await expect(next).resolves.toEqual({ matches: [] });
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it('terminates a timed out worker, rejects its queue and restarts on demand', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup({ searchTimeoutMs: 20 });
    const first = client.search({ cwd: '/project', query: 'stuck' });
    const second = client.index({ cwd: '/project' });
    const failures = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(21);
    expect((await failures).every(result => result.status === 'rejected')).toBe(true);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = client.search({ cwd: '/project', query: 'retry' });
    workers[0].emit('exit', 1);
    workers[1].emit('message', { id: 3, ok: true, result: { matches: [] } });
    await expect(retry).resolves.toEqual({ matches: [] });
  });
  it('expires queued lexical work without interrupting a long index or executing stale work', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup({ searchTimeoutMs: 20, indexTimeoutMs: 1000 });
    const index = client.index({ cwd: '/project' });
    const queued = client.search({ cwd: '/project', query: 'queued' });
    const rejected = expect(queued).rejects.toThrow('queue wait timed out');
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(workers[0].terminate).not.toHaveBeenCalled();
    expect(workers[0].tasks).toHaveLength(1);
    workers[0].emit('message', { id: 1, ok: true, result: { documents: 2 } });
    await expect(index).resolves.toEqual({ documents: 2 });
    expect(workers[0].tasks).toHaveLength(1);
    const next = client.search({ cwd: '/project', query: 'fresh' });
    expect(workers[0].tasks.map(task => task.id)).toEqual([1, 3]);
    workers[0].emit('message', { id: 3, ok: true, result: { matches: [] } });
    await expect(next).resolves.toEqual({ matches: [] });
  });
  it('rejects work after close and cancels pending work', async () => {
    const { client, workers } = setup();
    const pending = client.search({ cwd: '/project', query: 'pending' });
    const check = expect(pending).rejects.toThrow('closed');
    await client.close();
    await check;
    await expect(client.index({ cwd: '/project' })).rejects.toThrow('closed');
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('rejects all pending requests when a worker fails without disclosing private error details', async () => {
    const { client, workers } = setup();
    const pending = client.search({ cwd: '/project', query: 'private' });
    workers[0].emit('error', new Error('private corpus content'));
    await expect(pending).rejects.toThrow('QMD worker failed; retry the operation.');
  });
});
