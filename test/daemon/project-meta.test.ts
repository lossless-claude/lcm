import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectDir, projectMetaPath } from "../../src/daemon/project.js";
import { openProject } from "../../src/daemon/project-group.js";
import { readProjectMeta, readProjectMetaIn, updateProjectMeta, updateProjectMetaIn } from "../../src/daemon/project-meta.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());
const SRC_DIR = join(import.meta.dirname, "..", "..", "src");
const OWNER = join("daemon", "project-meta.ts");

const tempDirs: string[] = [];
let daemon: DaemonInstance | undefined;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = undefined; }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-project-meta-"));
  tempDirs.push(cwd);
  return realpathSync(cwd);
}

function seedMeta(cwd: string, content: string): string {
  const metaPath = projectMetaPath(cwd, paths);
  mkdirSync(dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, content);
  return metaPath;
}

/** The `meta.json.corrupt-*` siblings a project directory holds. */
const corruptCopies = (cwd: string): string[] =>
  readdirSync(projectDir(cwd, paths)).filter((name) => name.startsWith("meta.json.corrupt-"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

async function startDaemon(): Promise<string> {
  daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 }, summarizer: { mock: true } }));
  return `http://127.0.0.1:${daemon.address().port}`;
}

async function post(baseUrl: string, route: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const messages = Array.from({ length: 100 }, (_, i) => [
  { role: "user", content: `user message ${i}`, tokenCount: 100 },
  { role: "assistant", content: `assistant response ${i}`, tokenCount: 100 },
]).flat();

describe("project meta owner", () => {
  it("reads absent, unparsable and non-object files as null", () => {
    const cwd = newCwd();
    expect(readProjectMeta(cwd, paths)).toBeNull();
    seedMeta(cwd, "{ not json");
    expect(readProjectMeta(cwd, paths)).toBeNull();
    seedMeta(cwd, "[1, 2]");
    expect(readProjectMetaIn(projectDir(cwd, paths))).toBeNull();
    seedMeta(cwd, JSON.stringify({ cwd, language: "de" }));
    expect(readProjectMeta(cwd, paths)).toEqual({ cwd, language: "de" });
    expect(corruptCopies(cwd)).toEqual([]);
  });

  it("merges a patch into the existing record and leaves no temporary file", () => {
    const cwd = newCwd();
    seedMeta(cwd, JSON.stringify({ cwd: "/elsewhere", language: "de", extra: { kept: true } }));
    expect(updateProjectMeta(cwd, paths, { lastIngest: "t1" })).toEqual({ cwd, language: "de", extra: { kept: true }, lastIngest: "t1" });
    expect(readProjectMeta(cwd, paths)).toEqual({ cwd, language: "de", extra: { kept: true }, lastIngest: "t1" });
    expect(readdirSync(projectDir(cwd, paths))).toEqual(["meta.json"]);
  });

  it("keeps git, language and lastIngest through openProject, /ingest, /compact and /promote", async () => {
    const cwd = newCwd();
    const git = { remotes: ["example.invalid/owner/repo"], relPath: "", checkedAt: new Date().toISOString() };
    seedMeta(cwd, JSON.stringify({ cwd, git, language: "de", lastIngest: "seeded" }));

    openProject(cwd, paths);
    const baseUrl = await startDaemon();
    await post(baseUrl, "/ingest", { session_id: "s1", cwd, messages });
    await post(baseUrl, "/compact", { session_id: "s1", cwd });
    await post(baseUrl, "/promote", { cwd });

    const meta = readProjectMeta(cwd, paths);
    expect(meta).toMatchObject({ cwd, git, language: "de" });
    expect(meta?.lastIngest).not.toBe("seeded");
    for (const key of ["lastIngest", "lastCompact", "lastPromote"]) expect(typeof meta?.[key], key).toBe("string");
    expect(corruptCopies(cwd)).toEqual([]);
  });

  it("applies the same corrupt-file policy whichever writer meets the file first", async () => {
    const viaOpenProject = newCwd();
    const viaIngest = newCwd();
    const viaDirectory = newCwd();
    for (const cwd of [viaOpenProject, viaIngest, viaDirectory]) seedMeta(cwd, "{ not json");

    openProject(viaOpenProject, paths);
    const baseUrl = await startDaemon();
    await post(baseUrl, "/ingest", { session_id: "s1", cwd: viaIngest, messages: messages.slice(0, 2) });
    updateProjectMetaIn(projectDir(viaDirectory, paths), { cwd: viaDirectory, lastPromote: "t1" });

    for (const [cwd, key] of [[viaOpenProject, "git"], [viaIngest, "lastIngest"], [viaDirectory, "lastPromote"]] as const) {
      const copies = corruptCopies(cwd);
      expect(copies, cwd).toHaveLength(1);
      expect(readFileSync(join(projectDir(cwd, paths), copies[0]), "utf-8")).toBe("{ not json");
      const meta = readProjectMeta(cwd, paths);
      expect(meta?.cwd, cwd).toBe(cwd);
      expect(meta?.[key], `${cwd} ${key}`).toBeDefined();
    }
  });

  it("no file outside the owner reads or writes a project meta.json itself", () => {
    const offenders = walk(SRC_DIR)
      .filter((path) => !path.endsWith(OWNER))
      .filter((path) => {
        const source = readFileSync(path, "utf-8");
        const namesProjectMeta = /(?<![.\w])["']meta\.json["']/.test(source) || /\bprojectMetaPath\(/.test(source);
        return namesProjectMeta && /\b(?:read|write)FileSync\(/.test(source);
      });
    expect(offenders).toEqual([]);
    expect(existsSync(join(SRC_DIR, OWNER))).toBe(true);
  });
});
