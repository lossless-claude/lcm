import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDir, projectId, claudeTranscriptDirectory } from "../../daemon/project.js";
import { readProjectMetaIn } from "../../daemon/project-meta.js";
import { parseClaudeTranscriptRecord } from "../../transcript.js";
import { isExcluded, type CorpusConfig } from "../corpus-policy.js";
import { readShadowJson } from "../../daemon/shadow/store.js";
import { digest, object, objectHash, safeId, type ArmRecord, type NativeRecord, type ShadowManifest, type ShadowOriginal, type ShadowSnapshot } from "../../daemon/shadow/types.js";

export type TranscriptInput = { cwd: string; sessionId: string; path: string };
export type EvaluationCut = {
  cutId: string; projectId: string; cwd: string; sessionId: string; boundaryUuid: string;
  source: "shadow" | "historical"; sourceHash: string; snapshotHash: string | null;
  originals: ShadowOriginal[]; summaryCoverage: { summaryId: string; messageIds: number[] }[]; window: string | null; native: NativeRecord | null; arms: ArmRecord[];
  nativeParity: "not-checked" | "matched" | "mismatched";
};
export type CutCandidate = { projectId: string; sessionId: string; cutId: string; boundaryUuid?: string; native?: NativeRecord | null; load(): EvaluationCut };
export type ReadCounts = { excludedProjects: number; heldOutProjects: number; invalidSources: number; deduplicated: number };
const directory = (path: string): boolean => existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();

export function allowedProjects(paths: LcmPaths, policy: CorpusConfig, counts: ReadCounts): string[] {
  if (!directory(paths.projectsDir)) return [];
  return readdirSync(paths.projectsDir).flatMap(entry => allowedProject(join(paths.projectsDir, entry), { paths, policy, counts }));
}
function allowedProject(path: string, { paths, policy, counts }: { paths: LcmPaths; policy: CorpusConfig; counts: ReadCounts }): string[] {
  if (!directory(path)) return [];
  const cwd = readProjectMetaIn(path)?.cwd;
  if (!validProjectCwd(cwd, path, paths)) { counts.invalidSources++; return []; }
  if (isExcluded(cwd, policy.exclude)) { counts.excludedProjects++; return []; }
  if (policy.holdout.has(projectId(cwd))) { counts.heldOutProjects++; return []; }
  return [cwd];
}
function validProjectCwd(cwd: unknown, path: string, paths: LcmPaths): cwd is string {
  return typeof cwd === "string" && isAbsolute(cwd) && projectDir(cwd, paths) === path;
}
function loadShadow(path: string, manifest: ShadowManifest): EvaluationCut {
  const snapshot = readShadowJson<ShadowSnapshot>(join(path, "snapshot.json"));
  if (!validSnapshot(snapshot, manifest)) throw new Error("Invalid frozen snapshot");
  const sourceIds = new Set(snapshot.originals.map(row => row.id));
  if (snapshot.window.coverage.capturedMessageIds.some(id => !sourceIds.has(id))) throw new Error("Missing captured originals");
  const native = existsSync(join(path, "native.json")) ? readShadowJson<NativeRecord>(join(path, "native.json")) : null;
  const arms = readdirSync(path).filter(file => /^arm-[ABC]-[A-Za-z0-9_-]+\.json$/.test(file)).sort().map(file => readShadowJson<ArmRecord>(join(path, file)));
  return { cutId: manifest.cutId, cwd: manifest.cwd, projectId: manifest.projectId, sessionId: manifest.sessionId, boundaryUuid: manifest.boundaryUuid,
    source: "shadow", sourceHash: snapshot.sourceHash, snapshotHash: manifest.snapshotHash, originals: snapshot.originals, summaryCoverage: snapshot.window.coverage.summaryCoverage, window: snapshot.window.text, native, arms, nativeParity: "not-checked" };
}
function validSnapshot(snapshot: ShadowSnapshot, manifest: ShadowManifest): boolean {
  if (snapshot.version !== 1 || objectHash(snapshot) !== manifest.snapshotHash) return false;
  if (!Array.isArray(snapshot.originals)) return false;
  return snapshot.window?.coverage.valid && !snapshot.window.coverage.uncoveredMessageIds.length;
}
export function shadowCandidates(cwds: readonly string[], paths: LcmPaths, counts: ReadCounts): CutCandidate[] {
  return cwds.flatMap(cwd => projectCandidates(cwd, paths, counts));
}
function projectCandidates(cwd: string, paths: LcmPaths, counts: ReadCounts): CutCandidate[] {
  const root = join(projectDir(cwd, paths), "compaction-shadow");
  if (!directory(root)) return [];
  return readdirSync(root).flatMap(entry => cutCandidate({ cwd, root, entry }, counts));
}
function cutCandidate({ cwd, root, entry }: { cwd: string; root: string; entry: string }, counts: ReadCounts): CutCandidate[] {
  const path = join(root, entry);
  if (!safeId(entry) || !directory(path)) return [];
  try {
    const manifest = readShadowJson<ShadowManifest>(join(path, "manifest.json"));
    validateCutManifest(manifest, { cwd, entry });
    const native = existsSync(join(path, "native.json")) ? readShadowJson<NativeRecord>(join(path, "native.json")) : null;
    return [{ projectId: manifest.projectId, sessionId: manifest.sessionId, cutId: entry, boundaryUuid: manifest.boundaryUuid, native, load: () => loadShadow(path, manifest) }];
  } catch { counts.invalidSources++; return []; }
}
function validateCutManifest(manifest: ShadowManifest, { cwd, entry }: { cwd: string; entry: string }): void {
  if (manifest.version !== 1 || !safeId(manifest.sessionId)) throw new Error("Invalid cut version/session");
  if (manifest.cwd !== cwd || manifest.projectId !== projectId(cwd)) throw new Error("Invalid project binding");
  if (manifest.cutId !== entry) throw new Error("Invalid cut identity");
}
export function discoverTranscripts(cwds: readonly string[]): TranscriptInput[] {
  const found = cwds.flatMap(projectTranscripts);
  return [...new Map(found.map(input => [input.path, input])).values()];
}
function projectTranscripts(cwd: string): TranscriptInput[] {
  const root = claudeTranscriptDirectory(cwd);
  if (!directory(root)) return [];
  return readdirSync(root).flatMap(file => {
    const sessionId = file.replace(/\.jsonl$/, "");
    return file.endsWith(".jsonl") && safeId(sessionId) ? [{ cwd, sessionId, path: join(root, file) }] : [];
  });
}
function nativeText(row: Record<string, unknown>): string {
  if (!object(row.message)) throw new Error("No native message");
  const content = row.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some(block => !nativeTextBlock(block))) throw new Error("Unknown native text blocks");
  return content.map(block => block.text).join("\n");
}
function nativeTextBlock(block: unknown): boolean {
  return object(block) && block.type === "text" && typeof block.text === "string";
}
type HistoryRecord = { row: Record<string, unknown>; line: string; ordinal: number };
function ancestry(rows: Map<string, HistoryRecord>, parent: unknown, before: number) {
  const ordered: HistoryRecord[] = [], seen = new Set<string>();
  while (parent !== null) {
    if (typeof parent !== "string") throw new Error("Missing cut parent");
    if (seen.has(parent) || !rows.has(parent)) throw new Error("Unresolvable cut ancestry");
    const record = rows.get(parent)!;
    if (record.ordinal >= before) throw new Error("Cut ancestry reaches a later transcript row");
    seen.add(parent); ordered.push(record); parent = record.row.parentUuid; before = record.ordinal;
  }
  return ordered.reverse();
}
function prefix(rows: Map<string, HistoryRecord>, parent: unknown, before: number) {
  const originals = ancestry(rows, parent, before).flatMap(originalRecord).map((row, index) => ({ ...row, id: index + 1, seq: index }));
  if (!originals.length) throw new Error("No verified pre-cut originals");
  return { originals, boundaryUuid: originals.at(-1)!.uuid! };
}
function originalRecord({ row, line }: { row: Record<string, unknown>; line: string }): Omit<ShadowOriginal, "id" | "seq">[] {
  if (row.isCompactSummary || row.subtype === "compact_boundary") return [];
  const parsed = parseClaudeTranscriptRecord(line).message;
  if (!parsed) return [];
  return [{ role: parsed.role, text: parsed.content, uuid: row.uuid as string, origin: realUserRow(row, parsed.role) ? "user" : "other" }];
}
function realUserRow(row: Record<string, unknown>, role: string): boolean {
  return row.type === "user" && role === "user" && !row.isMeta;
}
export function historicalCuts(input: TranscriptInput): EvaluationCut[] {
  if (!isAbsolute(input.path) || !safeId(input.sessionId) || lstatSync(input.path).isSymbolicLink()) throw new Error("Invalid transcript metadata");
  const raw = readFileSync(input.path, "utf8"), rows = new Map<string, HistoryRecord>();
  indexHistory(raw, input.sessionId, rows);
  const result: EvaluationCut[] = [];
  for (const { row, ordinal } of rows.values()) {
    if (row.isCompactSummary !== true) continue;
    const { originals, boundaryUuid } = prefix(rows, row.parentUuid, ordinal), text = nativeText(row);
    result.push({ cutId: `historical-${digest(JSON.stringify([projectId(input.cwd), input.sessionId, row.uuid])).slice(0, 24)}`, projectId: projectId(input.cwd), cwd: input.cwd,
      sessionId: input.sessionId, boundaryUuid, source: "historical", sourceHash: digest(raw), snapshotHash: null, originals, summaryCoverage: [], window: null, arms: [], nativeParity: "not-checked",
      native: { text, outcome: "answered", usage: null, durationMs: null, costUsd: null, tail: [], summaryUuid: row.uuid as string, rawTextHash: digest(text), rawTextBytes: Buffer.byteLength(text) } });
  }
  return result;
}

function indexHistory(raw: string, sessionId: string, rows: Map<string, HistoryRecord>): void {
  for (const [ordinal, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (!object(row) || row.sessionId !== undefined && row.sessionId !== sessionId) throw new Error("Transcript identity mismatch");
    if (typeof row.uuid !== "string") continue;
    if (rows.has(row.uuid)) throw new Error("Duplicate transcript uuid");
    rows.set(row.uuid, { row, line, ordinal });
  }

}
