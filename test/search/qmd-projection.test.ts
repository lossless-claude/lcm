import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/daemon/project.js', () => ({
  projectDir: (cwd: string) => join(state.root, cwd),
  projectDbPath: (cwd: string) => join(state.root, cwd, 'db.sqlite'),
  projectId: (cwd: string) => cwd,
}));
import { qmdPaths, syncProjection, readProjection, resolveProjectedHits } from '../../src/search/qmd-projection.js';

let db: DatabaseSync;
const text = 'A real decision: preserve SQLite as the canonical source.\nUnicode: ação 日本語.';
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'lcm-projection-'));
  mkdirSync(join(state.root, 'project'));
  db = new DatabaseSync(join(state.root, 'project', 'db.sqlite'));
  db.exec(`CREATE TABLE conversations (conversation_id INTEGER, session_id TEXT);
    CREATE TABLE messages (message_id INTEGER, conversation_id INTEGER, content TEXT, created_at TEXT);
    CREATE TABLE summaries (summary_id TEXT, conversation_id INTEGER, content TEXT, created_at TEXT);
    CREATE TABLE promoted (id TEXT, content TEXT, tags TEXT, project_id TEXT, session_id TEXT, created_at TEXT, archived_at TEXT);
    INSERT INTO conversations VALUES (1, 'codex-session');`);
  db.prepare('INSERT INTO messages VALUES (1,1,?,?)').run(text, '2026-09-07');
  db.prepare('INSERT INTO summaries VALUES (?,1,?,?)').run('../unsafe', text, '2026-09-07');
  db.prepare('INSERT INTO promoted VALUES (?,?,?,?,?,?,NULL)').run('note', text, '["design"]', 'project', 'claude-session', '2026-09-07');
});
afterEach(() => { db.close(); rmSync(state.root, { recursive: true, force: true }); });
function hits() {
  return Object.keys(readProjection('project')!.records).map(file => ({ file: `qmd://lcm/${file}`, score: 0.9 }));
}
describe('QMD canonical projection', () => {
  it('retains exact text and separate identities for duplicate content without modifying source DB', () => {
    const dbPath = join(state.root, 'project', 'db.sqlite');
    const before = readFileSync(dbPath);
    const receipt = syncProjection('project');
    expect(receipt.written).toBe(3);
    for (const file of Object.keys(receipt.manifest.records)) {
      expect(file).toMatch(/^(message|summary|promoted)-[a-f0-9]{64}\.md$/);
      expect(readFileSync(join(qmdPaths('project').documentsPath, file), 'utf8')).toBe(text);
    }
    const result = resolveProjectedHits({ cwd: 'project', hits: hits(), limit: 10 });
    expect(new Set(result.matches.map(match => match.ref)).size).toBe(3);
    for (const match of result.matches) expect(match.ref).toContain(`?revision=${match.sourceHash}`);
    expect(result.matches[0].sessionId).toBe('codex-session');
    expect(readFileSync(dbPath)).toEqual(before);
  });
  it('only rewrites changed documents and only removes previously managed files', () => {
    syncProjection('project');
    const file = Object.keys(readProjection('project')!.records)[0];
    const target = join(qmdPaths('project').documentsPath, file);
    const mtime = statSync(target).mtimeMs;
    expect(syncProjection('project')).toMatchObject({ written: 0, removed: 0, unchanged: 3 });
    expect(statSync(target).mtimeMs).toBe(mtime);
    writeFileSync(join(qmdPaths('project').documentsPath, 'foreign.md'), 'keep');
    db.exec("UPDATE messages SET content = 'updated'; DELETE FROM summaries;");
    expect(syncProjection('project')).toMatchObject({ written: 1, removed: 1, unchanged: 1 });
    expect(existsSync(join(qmdPaths('project').documentsPath, 'foreign.md'))).toBe(true);
  });
  it('rejects stale, deleted, archived and foreign records', () => {
    syncProjection('project');
    const original = hits();
    db.exec("UPDATE messages SET content='changed'; DELETE FROM summaries; UPDATE promoted SET archived_at='today';");
    expect(resolveProjectedHits({ cwd: 'project', hits: original, limit: 10 })).toEqual({ matches: [], staleCount: 3 });
    expect(resolveProjectedHits({ cwd: 'project', hits: [{ file: original[0].file.replace('lcm/', 'other/'), score: 1 }, { file: 'qmd://lcm/../foreign.md', score: 1 }], limit: 10 }).matches).toEqual([]);
  });
  it('uses current tag metadata and filters layer, project and duplicate hits', () => {
    db.prepare('INSERT INTO promoted VALUES (?,?,?,?,?,?,NULL)').run('foreign', text, '["design"]', 'other', 'session', 'today');
    syncProjection('project');
    expect(hits()).toHaveLength(3);
    expect(resolveProjectedHits({ cwd: 'project', hits: [...hits(), ...hits()], limit: 10, tags: ['design'] }).matches).toHaveLength(1);
    expect(resolveProjectedHits({ cwd: 'project', hits: hits(), limit: 10, layers: ['episodic'] }).matches).toHaveLength(2);
    db.exec("UPDATE promoted SET tags='[]'");
    expect(resolveProjectedHits({ cwd: 'project', hits: hits(), limit: 10, tags: ['design'] }).matches).toHaveLength(0);
  });
  it('removes projections that become whitespace so old QMD text cannot resolve', () => {
    syncProjection('project');
    const previousHits = hits();
    const messageHit = previousHits.find(hit => hit.file.includes('/message-'))!;
    const messageFile = messageHit.file.replace('qmd://lcm/', '');
    db.exec("UPDATE messages SET content = '   ';");
    expect(syncProjection('project')).toMatchObject({ written: 0, removed: 1, unchanged: 2 });
    expect(existsSync(join(qmdPaths('project').documentsPath, messageFile))).toBe(false);
    expect(readProjection('project')!.records[messageFile]).toBeUndefined();
    expect(resolveProjectedHits({ cwd: 'project', hits: [messageHit], limit: 10 }).matches).toEqual([]);
  });
  it('projects and resolves manually stored notes within the project database', () => {
    db.prepare('INSERT INTO promoted VALUES (?,?,?,?,?,?,NULL)').run('manual-note', 'Manual durable memory', '["design"]', 'manual', null, 'today');
    syncProjection('project');
    const result = resolveProjectedHits({ cwd: 'project', hits: hits(), limit: 10, layers: ['promoted'] });
    expect(result.matches.find(match => match.id === 'manual-note')).toMatchObject({ content: 'Manual durable memory', sessionId: null });
  });
  it('refuses missing source databases without modifying a previous projection', () => {
    syncProjection('project');
    const manifestBefore = readFileSync(qmdPaths('project').manifestPath, 'utf8');
    rmSync(join(state.root, 'project', 'db.sqlite'));
    expect(() => syncProjection('project')).toThrow('no source database');
    expect(readFileSync(qmdPaths('project').manifestPath, 'utf8')).toBe(manifestBefore);
    expect(existsSync(join(qmdPaths('project').documentsPath, Object.keys(readProjection('project')!.records)[0]))).toBe(true);
  });
  it('returns bounded canonical spans even when QMD chunk text or offset is wrong', () => {
    const long = 'x'.repeat(1500) + text;
    db.prepare('UPDATE messages SET content=?').run(long);
    syncProjection('project');
    const hit = hits()[0];
    for (const chunk of [{ bestChunk: text, bestChunkPos: 1500 }, { bestChunk: text, bestChunkPos: 44 }, { bestChunk: 'invented header', bestChunkPos: -1 }]) {
      const match = resolveProjectedHits({ cwd: 'project', hits: [{ ...hit, ...chunk }], limit: 1 }).matches[0];
      expect(match.snippet).toBe(long.slice(match.span.start, match.span.end));
      expect(match.snippet.length).toBeLessThanOrEqual(1000);
    }
  });
});
