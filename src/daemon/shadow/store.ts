import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDir } from "../project.js";
import { readProjectMetaInNoLinks } from "../project-meta.js";
import { HTTP, objectHash, safeId, type ArmRecord, type NativeRecord, type ShadowManifest, type ShadowSnapshot } from "./types.js";

export class ShadowStoreError extends Error {
  constructor(message: string, readonly status: number = HTTP.conflict) { super(message); }
}
function directory(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}
function regularFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
}
function verifyDirectories(paths: string[]): void {
  for (const path of paths) {
    const stat = existingDirectoryEntry(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ShadowStoreError("Invalid shadow directory", HTTP.unprocessable);
  }
}
function existingDirectoryEntry(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function removeShadowDirectory(path: string, projectsDir: string): void {
  if (!existsSync(path)) return;
  verifyDirectories([projectsDir, dirname(dirname(path)), dirname(path), path]);
  const inside = relative(realpathSync(projectsDir), realpathSync(path));
  if (!inside || inside.split(sep)[0] === ".." || isAbsolute(inside))
    throw new ShadowStoreError("Shadow cleanup escapes projects directory", HTTP.unprocessable);
  rmSync(path, { recursive: true, force: true });
}
export function readShadowJson<T>(path: string): T {
  if (!regularFile(path)) throw new ShadowStoreError("Invalid shadow artifact", HTTP.unprocessable);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function atomicWrite(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

/** Independent files make native/arm completion order irrelevant to corpus integrity. */
export class CompactionShadowStore {
  readonly owner = randomUUID();
  constructor(private readonly paths: LcmPaths) {}
  get projectsDir(): string { return this.paths.projectsDir; }
  root(cwd: string): string { return join(projectDir(cwd, this.paths), "compaction-shadow"); }
  private cutDir(cwd: string, cutId: string): string {
    if (!safeId(cutId)) throw new ShadowStoreError("Invalid cut id", HTTP.badRequest);
    const root = this.root(cwd);
    const path = join(root, cutId);
    verifyDirectories([this.projectsDir, dirname(root), root, path]);
    return path;
  }
  read(cwd: string, cutId: string): { cut: ShadowManifest; snapshot: ShadowSnapshot } | undefined {
    const path = this.cutDir(cwd, cutId);
    if (!existsSync(join(path, "manifest.json"))) return undefined;
    return { cut: readShadowJson(join(path, "manifest.json")), snapshot: readShadowJson(join(path, "snapshot.json")) };
  }
  create(cut: ShadowManifest, snapshot: ShadowSnapshot): void {
    const path = this.cutDir(cut.cwd, cut.cutId);
    if (existsSync(path)) throw new ShadowStoreError("Cut already exists");
    mkdirSync(this.root(cut.cwd), { recursive: true, mode: 0o700 });
    const staging = join(this.root(cut.cwd), `.staging-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      atomicWrite(join(staging, "snapshot.json"), snapshot);
      atomicWrite(join(staging, "manifest.json"), cut);
      renameSync(staging, path);
    } finally { removeShadowDirectory(staging, this.projectsDir); }
  }
  bind(cwd: string, cutId: string, { sessionId, snapshotHash }: { sessionId: string; snapshotHash: string }): { cut: ShadowManifest; snapshot: ShadowSnapshot } {
    const found = this.read(cwd, cutId);
    if (!found) throw new ShadowStoreError("Cut not found", HTTP.notFound);
    if (found.cut.sessionId !== sessionId || found.cut.snapshotHash !== snapshotHash || objectHash(found.snapshot) !== snapshotHash)
      throw new ShadowStoreError("Cut identity or snapshot mismatch");
    if (Date.parse(found.cut.expiresAt) <= Date.now()) throw new ShadowStoreError("Cut expired", HTTP.gone);
    return found;
  }
  writeNative(cut: ShadowManifest, record: NativeRecord): void { this.publish(cut, "native.json", record); }
  writeArm(cut: ShadowManifest, record: ArmRecord): void { this.publish(cut, `arm-${record.arm}-${record.attemptId}.json`, record); }
  private publish(cut: ShadowManifest, name: string, record: NativeRecord | ArmRecord): void {
    const path = this.cutDir(cut.cwd, cut.cutId), file = join(path, name);
    if (existsSync(file)) {
      if (objectHash(readShadowJson(file)) !== objectHash(record)) throw new ShadowStoreError("Result conflicts with an earlier delivery");
      return;
    }
    atomicWrite(file, record);
    const files = readdirSync(path);
    const complete = files.includes("native.json") && cut.expectedArms.every(arm => files.some(file => file.startsWith(`arm-${arm}-`) && file.endsWith(".json")));
    if (complete) atomicWrite(join(path, "manifest.json"), { ...cut, state: "complete" });
  }
}
const RECOVERY_BATCH_SIZE = 64;
/** Bounded cleanup never follows directory links or mutates episodic storage. */
export function recoverShadowProject(store: CompactionShadowStore, cwd: string, { now = Date.now(), limit = RECOVERY_BATCH_SIZE } = {}): number {
  const root = store.root(cwd);
  if (![store.projectsDir, dirname(root), root].every(directory)) return 0;
  let changed = 0, failures = 0;
  for (const entry of readdirSync(root)) {
    if (changed >= limit || !safeId(entry)) continue;
    const result = recoverShadowEntry(join(root, entry), { cwd, owner: store.owner, now, projectsDir: store.projectsDir });
    changed += Number(result.changed); failures += Number(result.failed);
  }
  return failures;
}
function recoverShadowEntry(path: string, context: { cwd: string; owner: string; now: number; projectsDir: string }): { changed: boolean; failed: boolean } {
  try {
    if (!directory(path) || !regularFile(join(path, "manifest.json"))) return { changed: false, failed: false };
    const file = join(path, "manifest.json"), cut = readShadowJson<ShadowManifest>(file);
    if (!recoverableCut(cut, context.cwd, path)) return { changed: false, failed: false };
    if (Date.parse(cut.expiresAt) <= context.now) { removeShadowDirectory(path, context.projectsDir); return { changed: true, failed: false }; }
    return recoverPending(file, cut, context.owner);
  } catch { return { changed: false, failed: true }; }
}
function recoverPending(file: string, cut: ShadowManifest, owner: string) {
  if (cut.state !== "pending" || cut.owner === owner) return { changed: false, failed: false };
  atomicWrite(file, { ...cut, state: "incomplete" });
  return { changed: true, failed: false };
}
export function recoverShadowProjects(store: CompactionShadowStore, paths: LcmPaths): number {
  if (!directory(paths.projectsDir)) return 0;
  let failures = 0;
  for (const entry of readdirSync(paths.projectsDir)) {
    failures += recoverProjectAt(join(paths.projectsDir, entry), { store, paths });
  }
  return failures;
}
function recoverProjectAt(path: string, { store, paths }: { store: CompactionShadowStore; paths: LcmPaths }): number {
  if (![path, join(path, "compaction-shadow")].every(directory)) return 0;
  try {
    const cwd = readProjectMetaInNoLinks(path)?.cwd;
    return typeof cwd === "string" && projectDir(cwd, paths) === path ? recoverShadowProject(store, cwd) : 0;
  } catch { return 1; }
}
function recoverableCut(cut: ShadowManifest, cwd: string, path: string): boolean {
  return cut.version === 1 && cut.cwd === cwd && basename(path) === cut.cutId;
}
