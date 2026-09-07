import { sanitizeError } from '../daemon/safe-error.js';
import { parentPort } from 'node:worker_threads';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createStore, type QMDStore } from '@tobilu/qmd';
import { qmdPaths, syncProjection, readProjection, resolveProjectedHits, QMD_COLLECTION } from './qmd-projection.js';
import type { QmdCapabilities, QmdIndexRequest, QmdIndexResult, QmdSearchRequest, QmdSearchResult, QmdTask, QmdReply } from './qmd-protocol.js';

let current: { cwd: string; store: QMDStore } | undefined;
async function openStore(cwd: string): Promise<QMDStore> {
  const project = resolve(cwd);
  if (current?.cwd === project) return current.store;
  if (current) { await current.store.close(); current = undefined; }
  const paths = qmdPaths(project);
  const store = await createStore({ dbPath: paths.dbPath, config: {
    collections: { [QMD_COLLECTION]: { path: paths.documentsPath, pattern: '{message,summary,promoted}-*.md' } },
  } });
  current = { cwd: project, store };
  return store;
}
function revision(manifest: object): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
function receiptPath(cwd: string): string { return join(qmdPaths(cwd).root, 'indexed-revision'); }
async function capabilities(store: QMDStore): Promise<QmdCapabilities> {
  const status = await store.getStatus();
  return { lexical: true, embeddingReady: status.hasVectorIndex && status.needsEmbedding === 0, needsEmbedding: status.needsEmbedding };
}
async function index(request: QmdIndexRequest): Promise<QmdIndexResult> {
  const receipt = receiptPath(request.cwd);
  rmSync(receipt, { force: true });
  const projection = syncProjection(request.cwd);
  const store = await openStore(request.cwd);
  const update = await store.update({ collections: [QMD_COLLECTION] });
  const documents = Object.keys(projection.manifest.records).length;
  const status = await store.getStatus();
  if (update.skipped !== 0 || update.collections !== 1 || status.totalDocuments !== documents) {
    throw new Error('QMD indexing was incomplete. Run lcm index again.');
  }
  const projectionRevision = revision(projection.manifest);
  writeFileSync(`${receipt}.tmp`, projectionRevision, { mode: 0o600 });
  renameSync(`${receipt}.tmp`, receipt);
  if (request.embed) {
    const result = await store.embed({ collection: QMD_COLLECTION });
    const readiness = await capabilities(store);
    if (result.errors > 0 || result.failures?.length || !readiness.embeddingReady) {
      throw new Error('QMD embedding was incomplete; lexical search remains available. Run lcm index --embed again.');
    }
  }
  return {
    engine: 'qmd', documents: Object.keys(projection.manifest.records).length,
    written: projection.written, removed: projection.removed, unchanged: projection.unchanged,
    embedded: Boolean(request.embed), projectionRevision, capabilities: await capabilities(store),
  };
}
function requireIndex(cwd: string): string {
  const manifest = readProjection(cwd);
  if (!manifest || !existsSync(qmdPaths(cwd).dbPath) || !existsSync(receiptPath(cwd))) {
    throw new Error('QMD index is not ready. Run lcm index first.');
  }
  const projectionRevision = revision(manifest);
  if (readFileSync(receiptPath(cwd), 'utf8') !== projectionRevision) {
    throw new Error('QMD projection is not fully indexed. Run lcm index again.');
  }
  return projectionRevision;
}
async function search(request: QmdSearchRequest): Promise<QmdSearchResult> {
  if (!request.query.trim()) throw new Error('QMD search query must not be empty.');
  const projectionRevision = requireIndex(request.cwd);
  const store = await openStore(request.cwd);
  const readiness = await capabilities(store);
  const strategy = request.mode ?? 'lexical';
  if (strategy === 'hybrid' && !readiness.embeddingReady) {
    throw new Error('QMD embeddings are not ready. Run lcm index --embed first.');
  }
  const limit = Math.max(1, Math.min(100, Math.floor(request.limit ?? 10)));
  const candidateLimit = Math.min(1000, Math.max(40, limit * 10));
  const hits = strategy === 'hybrid'
    ? await store.search({ query: request.query, limit: candidateLimit, candidateLimit, rerank: true, collection: QMD_COLLECTION })
    : (await store.searchLex(request.query, { limit: candidateLimit, collection: QMD_COLLECTION }))
      .map(hit => ({ file: hit.filepath, score: hit.score }));
  const resolved = resolveProjectedHits({ cwd: request.cwd, hits, limit, layers: request.layers, tags: request.tags });
  const candidateCapReached = hits.length >= candidateLimit;
  return { engine: 'qmd', strategy, ...resolved, candidateCount: hits.length, candidateLimit,
    candidateCapReached, partial: resolved.staleCount > 0 || candidateCapReached,
    projectionRevision, capabilities: readiness };
}

/** Return actionable categories and known OS codes, never arbitrary corpus-bearing SDK text. */
function describeFailure(error: unknown, operation: string): string {
  if (!(error instanceof Error)) return `QMD ${operation} failed with an unknown error.`;
  if (/^QMD |^Run lcm/.test(error.message)) return sanitizeError(error.message);
  const code = 'code' in error ? String(error.code) : '';
  const safeCodes = ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ENOMEM', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ERR_DLOPEN_FAILED'];
  const diagnostic = safeCodes.includes(code) ? ` (${code})` : '';
  const reason = /SQLITE_|database|sqlite/i.test(error.message) ? 'database operation failed; rebuild the index and check disk space'
    : /download|fetch|network|https?:|connection/i.test(error.message) ? 'model download or network request failed; check connectivity and model availability'
    : /model|llama|gguf|metal|cuda|vulkan|out of memory/i.test(error.message) ? 'model initialization or inference failed; check model files and available memory'
    : /permission|EACCES|EPERM|ENOENT|ENOSPC/i.test(error.message) ? 'file access failed; check index permissions and disk space'
    : 'SDK operation failed; check index permissions and SDK/model availability';
  return sanitizeError(`QMD ${operation} failed${diagnostic}: ${reason}.`);
}

const port = parentPort;
let queue = Promise.resolve();
export async function runQmdTask(task: QmdTask): Promise<QmdReply> {
  try {
    const result = task.operation === 'index' ? await index(task.request) : await search(task.request);
    return { id: task.id, ok: true, result };
  } catch (error) {
    return { id: task.id, ok: false, error: describeFailure(error, task.operation) };
  }
}
port?.on('message', (task: QmdTask) => {
  queue = queue.then(async () => {
    port.postMessage(await runQmdTask(task));
  });
});
