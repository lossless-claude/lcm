import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  root: '',
  sync: vi.fn(), update: vi.fn(), embed: vi.fn(), status: vi.fn(),
}));
vi.mock('@tobilu/qmd', () => ({ createStore: async () => ({
  update: mocks.update, embed: mocks.embed, getStatus: mocks.status, close: async () => {},
}) }));
vi.mock('../../src/search/qmd-projection.js', () => ({
  QMD_COLLECTION: 'lcm',
  qmdPaths: () => ({ root: mocks.root, dbPath: join(mocks.root, 'index.sqlite'), documentsPath: mocks.root }),
  syncProjection: mocks.sync,
  readProjection: vi.fn(), resolveProjectedHits: vi.fn(),
}));
import { runQmdTask } from '../../src/search/qmd-worker.js';
const receipt = () => join(mocks.root, 'indexed-revision');
const index = (embed = false) => runQmdTask({ id: 1, operation: 'index', request: { cwd: mocks.root, embed } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root = mkdtempSync(join(tmpdir(), 'qmd-worker-'));
  mocks.sync.mockReturnValue({ manifest: { records: { 'message.md': {} } }, written: 1, removed: 0, unchanged: 0 });
  mocks.update.mockResolvedValue({ collections: 1, skipped: 0 });
  mocks.status.mockResolvedValue({ totalDocuments: 1, hasVectorIndex: true, needsEmbedding: 0 });
  mocks.embed.mockResolvedValue({ errors: 0, failures: [] });
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

it('invalidates the old receipt before projection mutation and preserves invalidity on failure', async () => {
  writeFileSync(receipt(), 'old');
  mocks.sync.mockImplementationOnce(() => {
    expect(existsSync(receipt())).toBe(false);
    throw new Error('private source text');
  });
  const result = await index();
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).not.toContain('private source text');
  expect(existsSync(receipt())).toBe(false);
});

it.each([
  { skipped: 1, collections: 1, totalDocuments: 1 },
  { skipped: 0, collections: 0, totalDocuments: 1 },
  { skipped: 0, collections: 1, totalDocuments: 0 },
])('does not certify incomplete lexical indexing: %j', async ({ skipped, collections, totalDocuments }) => {
  writeFileSync(receipt(), 'old');
  mocks.update.mockResolvedValue({ skipped, collections });
  mocks.status.mockResolvedValue({ totalDocuments });
  expect(await index()).toMatchObject({ ok: false, error: expect.stringContaining('incomplete') });
  expect(existsSync(receipt())).toBe(false);
});

it('publishes a lexical receipt without invoking embedding', async () => {
  expect(await index()).toMatchObject({ ok: true, result: { embedded: false } });
  expect(existsSync(receipt())).toBe(true);
  expect(mocks.embed).not.toHaveBeenCalled();
});

it.each([
  { errors: 1, failures: [], needsEmbedding: 0 },
  { errors: 0, failures: [{ reason: 'private text' }], needsEmbedding: 0 },
  { errors: 0, failures: [], needsEmbedding: 1 },
])('reports incomplete embedding while retaining lexical readiness: %j', async ({ errors, failures, needsEmbedding }) => {
  mocks.embed.mockResolvedValue({ errors, failures });
  mocks.status.mockResolvedValue({ totalDocuments: 1, hasVectorIndex: true, needsEmbedding });
  const result = await index(true);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('embedding was incomplete') });
  expect(JSON.stringify(result)).not.toContain('private text');
  expect(existsSync(receipt())).toBe(true);
});

it('reports embedded only when requested embedding completed', async () => {
  expect(await index(true)).toMatchObject({ ok: true, result: { embedded: true } });
  expect(mocks.embed).toHaveBeenCalledOnce();
});
