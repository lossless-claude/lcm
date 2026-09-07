import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectDbPath, projectDir, projectId } from '../daemon/project.js';

export const QMD_COLLECTION = 'lcm';
export type ProjectionKind = 'message' | 'summary' | 'promoted';
export interface ProjectionRecord {
  kind: ProjectionKind;
  id: string;
  revision: string;
  conversationId?: number;
  sessionId?: string | null;
  createdAt: string;
  tags?: string[];
}
export interface ProjectionManifest {
  version: 1;
  projectId: string;
  records: Record<string, ProjectionRecord>;
}
export interface QmdHit { file: string; bestChunk?: string; bestChunkPos?: number; score: number }
export interface ProjectedMatch {
  kind: ProjectionKind;
  ref: string;
  sourceHash: string;
  span: { start: number; end: number };
  snippet: string;
  content: string;
  score: number;
  id?: string;
  messageId?: number;
  summaryId?: string;
  conversationId?: number;
  sessionId?: string | null;
  createdAt: string;
  tags?: string[];
}
type SourceRecord = Omit<ProjectionRecord, 'revision'> & { content: string };
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const filename = (record: Pick<ProjectionRecord, 'kind' | 'id'>): string => `${record.kind}-${hash(record.id)}.md`;

export function qmdPaths(cwd: string) {
  const root = join(projectDir(cwd), 'qmd');
  return { root, documentsPath: join(root, 'documents'), dbPath: join(root, 'index.sqlite'), manifestPath: join(root, 'manifest.json') };
}

export function readProjection(cwd: string): ProjectionManifest | null {
  const path = qmdPaths(cwd).manifestPath;
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ProjectionManifest;
  if (manifest.version !== 1 || manifest.projectId !== projectId(cwd) || !manifest.records) {
    throw new Error('Invalid QMD projection manifest');
  }
  for (const [name, record] of Object.entries(manifest.records)) {
    if (!['message', 'summary', 'promoted'].includes(record.kind) || typeof record.id !== 'string' || name !== filename(record)) {
      throw new Error('Invalid QMD projection record');
    }
  }
  return manifest;
}

function episodicRecords(db: DatabaseSync, kind: 'message' | 'summary'): SourceRecord[] {
  const table = kind === 'message' ? 'messages' : 'summaries';
  return db.prepare(`SELECT CAST(s.${kind}_id AS TEXT) AS id, s.content,
    s.conversation_id AS conversationId, c.session_id AS sessionId, s.created_at AS createdAt
    FROM ${table} s JOIN conversations c USING (conversation_id) ORDER BY s.${kind}_id`)
    .all().map(row => ({ ...row, kind }) as unknown as SourceRecord);
}

function promotedRecords(db: DatabaseSync, cwd: string): SourceRecord[] {
  return db.prepare(`SELECT id, content, session_id AS sessionId, created_at AS createdAt, tags
    FROM promoted WHERE archived_at IS NULL AND project_id IN (?, 'manual') ORDER BY id`).all(projectId(cwd))
    .map(row => ({ ...row, kind: 'promoted', tags: JSON.parse(String(row.tags)) }) as SourceRecord);
}

function readSources(cwd: string): SourceRecord[] {
  if (!existsSync(projectDbPath(cwd))) throw new Error('QMD cannot index: no source database; ingest a session or store a memory first');
  const db = new DatabaseSync(projectDbPath(cwd), { readOnly: true });
  try {
    db.exec('BEGIN');
    return [...episodicRecords(db, 'message'), ...episodicRecords(db, 'summary'), ...promotedRecords(db, cwd)];
  } finally { db.close(); }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function syncProjection(cwd: string) {
  const paths = qmdPaths(cwd);
  const previous = readProjection(cwd);
  const sources = readSources(cwd).filter(source => source.content.trim().length > 0);
  const manifest: ProjectionManifest = { version: 1, projectId: projectId(cwd), records: {} };
  mkdirSync(paths.documentsPath, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const { content, ...source } of sources) {
    const name = filename(source);
    const revision = hash(content);
    manifest.records[name] = { ...source, revision };
    const target = join(paths.documentsPath, name);
    if (previous?.records[name]?.revision === revision && existsSync(target) && hash(readFileSync(target, 'utf8')) === revision) continue;
    atomicWrite(target, content);
    written++;
  }
  const removed = removeObsolete(paths.documentsPath, previous, manifest);
  atomicWrite(paths.manifestPath, JSON.stringify(manifest));
  return { manifest, written, removed, unchanged: sources.length - written };
}

function removeObsolete(path: string, previous: ProjectionManifest | null, next: ProjectionManifest): number {
  let removed = 0;
  for (const name of Object.keys(previous?.records ?? {})) {
    if (next.records[name]) continue;
    const target = join(path, name);
    if (existsSync(target)) { unlinkSync(target); removed++; }
  }
  return removed;
}

function hitFilename(file: string): string | undefined {
  // QMD's virtual path includes the collection. Never resolve arbitrary filesystem paths.
  const match = /^qmd:\/\/lcm\/((?:message|summary|promoted)-[a-f0-9]{64}\.md)$/.exec(file);
  return match?.[1];
}

function allowed(source: SourceRecord, layers?: string[], tags?: string[]): boolean {
  const layer = source.kind === 'promoted' ? 'promoted' : 'episodic';
  return (!layers || layers.includes(layer)) && (!tags?.length || (source.kind === 'promoted' && tags.every(tag => source.tags?.includes(tag))));
}

function sourceMatch(source: SourceRecord, hit: QmdHit, cwd: string): ProjectedMatch {
  let start = hit.bestChunkPos ?? 0;
  if (!hit.bestChunk || !Number.isInteger(start) || start < 0 || source.content.slice(start, start + hit.bestChunk.length) !== hit.bestChunk) {
    start = hit.bestChunk ? Math.max(0, source.content.indexOf(hit.bestChunk)) : 0;
  }
  const exactChunk = hit.bestChunk && source.content.slice(start, start + hit.bestChunk.length) === hit.bestChunk;
  const length = exactChunk ? Math.min(hit.bestChunk!.length, 1000) : 1000;
  const snippet = source.content.slice(start, start + length);
  return {
    kind: source.kind, ref: `lcm://${projectId(cwd)}/${source.kind}/${encodeURIComponent(source.id)}?revision=${hash(source.content)}`,
    sourceHash: hash(source.content), span: { start, end: start + snippet.length }, snippet, content: snippet, score: hit.score,
    ...(source.kind === 'message' ? { messageId: Number(source.id) } : source.kind === 'summary' ? { summaryId: source.id } : { id: source.id, tags: source.tags }),
    conversationId: source.conversationId, sessionId: source.sessionId, createdAt: source.createdAt,
  };
}

function readSource(db: DatabaseSync, record: ProjectionRecord, cwd: string): SourceRecord | undefined {
  if (record.kind === 'promoted') {
    const row = db.prepare(`SELECT id, content, session_id AS sessionId, created_at AS createdAt, tags
      FROM promoted WHERE id = ? AND project_id IN (?, 'manual') AND archived_at IS NULL`).get(record.id, projectId(cwd));
    return row ? { ...row, kind: 'promoted', tags: JSON.parse(String(row.tags)) } as SourceRecord : undefined;
  }
  const kind = record.kind;
  const table = kind === 'message' ? 'messages' : 'summaries';
  const row = db.prepare(`SELECT CAST(s.${kind}_id AS TEXT) AS id, s.content,
    s.conversation_id AS conversationId, c.session_id AS sessionId, s.created_at AS createdAt
    FROM ${table} s JOIN conversations c USING (conversation_id) WHERE s.${kind}_id = ?`).get(record.id);
  return row ? { ...row, kind } as unknown as SourceRecord : undefined;
}

export function resolveProjectedHits(options: { cwd: string; hits: QmdHit[]; limit: number; layers?: string[]; tags?: string[] }) {
  const manifest = readProjection(options.cwd);
  if (!manifest || !existsSync(projectDbPath(options.cwd))) return { matches: [], staleCount: options.hits.length };
  const db = new DatabaseSync(projectDbPath(options.cwd), { readOnly: true });
  try {
    db.exec('BEGIN');
    return resolveCurrentHits(db, manifest, options);
  } finally { db.close(); }
}

function resolveCurrentHits(db: DatabaseSync, manifest: ProjectionManifest, options: { cwd: string; hits: QmdHit[]; limit: number; layers?: string[]; tags?: string[] }) {
  const { cwd, hits, limit, layers, tags } = options;
  const matches: ProjectedMatch[] = [];
  const seen = new Set<string>();
  let staleCount = 0;
  for (const hit of hits) {
    const name = hitFilename(hit.file);
    if (!name || seen.has(name) || !Number.isFinite(hit.score)) continue;
    seen.add(name);
    const record = manifest.records[name];
    if (!record) continue;
    const source = readSource(db, record, cwd);
    if (!source || hash(source.content) !== record.revision) { staleCount++; continue; }
    if (matches.length < Math.max(0, Math.floor(limit)) && allowed(source, layers, tags)) matches.push(sourceMatch(source, hit, cwd));
  }
  return { matches, staleCount };
}
