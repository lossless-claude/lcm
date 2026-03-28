import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { PromotedStore } from "../src/db/promoted.js";
import {
  EXPORT_VERSION,
  exportKnowledge,
  importKnowledge,
  type ExportDocument,
} from "../src/portable-knowledge.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const d = mkdtempSync(join(tmpdir(), "lcm-portable-knowledge-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Compute the project ID the same way the real code does.
 */
function toProjectId(cwd: string): string {
  let real: string;
  try { real = realpathSync(cwd); } catch { real = cwd; }
  return createHash("sha256").update(real).digest("hex");
}

/**
 * Set up a fake ~/.lossless-claude project at `baseDir`
 * seeded with the given entries, and return the project dir.
 */
function seedProject(
  baseDir: string,
  cwd: string,
  entries: Array<{ content: string; tags?: string[]; confidence?: number; sessionId?: string }>,
) {
  const projId = toProjectId(cwd);
  const projDir = join(baseDir, "projects", projId);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "meta.json"), JSON.stringify({ cwd }));

  const dbPath = join(projDir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  runLcmMigrations(db);
  const store = new PromotedStore(db);

  for (const e of entries) {
    store.insert({
      content: e.content,
      tags: e.tags ?? [],
      projectId: projId,
      sessionId: e.sessionId,
      depth: 0,
      confidence: e.confidence ?? 1.0,
    });
  }
  db.close();

  return { projDir, projId, dbPath };
}

// ─── Export tests ────────────────────────────────────────────────────────────

describe("portable-knowledge — export", () => {
  it("exports entries to stdout (captured)", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    seedProject(baseDir, cwd, [
      { content: "We use TypeScript everywhere", tags: ["decision"] },
      { content: "Database is SQLite", tags: ["decision", "db"] },
    ]);

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any): boolean => { chunks.push(String(chunk)); return true; };

    try {
      const result = await exportKnowledge(cwd, { skipScrub: true, _lcmBaseDir: baseDir });
      expect(result.exported).toBe(2);
      expect(result.projectCwd).toBe(cwd);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    const doc: ExportDocument = JSON.parse(output);
    expect(doc.version).toBe(EXPORT_VERSION);
    expect(doc.projectCwd).toBe(cwd);
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0].content).toBe("We use TypeScript everywhere");
    expect(doc.entries[0].tags).toContain("decision");
    expect(typeof doc.entries[0].confidence).toBe("number");
    expect(typeof doc.entries[0].createdAt).toBe("string");
  });

  it("exports to a file when --output is specified", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "out.json");

    seedProject(baseDir, cwd, [{ content: "Entry one", tags: ["note"] }]);

    const result = await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });
    expect(result.exported).toBe(1);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].content).toBe("Entry one");
  });

  it("filters by tags", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "tagged.json");

    seedProject(baseDir, cwd, [
      { content: "Architecture decision", tags: ["decision", "architecture"] },
      { content: "Random note", tags: ["note"] },
    ]);

    const result = await exportKnowledge(cwd, {
      tags: ["decision"],
      output: outFile,
      skipScrub: true,
      _lcmBaseDir: baseDir,
    });
    expect(result.exported).toBe(1);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries[0].content).toBe("Architecture decision");
  });

  it("filters by since date (future date returns empty)", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "since.json");

    seedProject(baseDir, cwd, [{ content: "Old entry", tags: [] }]);

    const result = await exportKnowledge(cwd, {
      since: "2099-01-01",
      output: outFile,
      skipScrub: true,
      _lcmBaseDir: baseDir,
    });
    expect(result.exported).toBe(0);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries).toHaveLength(0);
  });

  it("throws if no database found", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    await expect(
      exportKnowledge(cwd, { skipScrub: true, _lcmBaseDir: baseDir }),
    ).rejects.toThrow(/No lossless-claude database found/);
  });

  it("export document has the correct shape", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "shape.json");

    seedProject(baseDir, cwd, [
      { content: "Shape test", tags: ["test"], confidence: 0.75, sessionId: "sess-abc" },
    ]);

    await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.version).toBe(1);
    expect(typeof doc.exportedAt).toBe("string");
    expect(doc.projectCwd).toBe(cwd);
    const e = doc.entries[0];
    expect(e.content).toBe("Shape test");
    expect(e.tags).toEqual(["test"]);
    expect(e.confidence).toBe(0.75);
    // sessionId is nullified on export so cross-project imports don't create
    // dead references pointing at sessions that don't exist in the new context.
    expect(e.sessionId).toBeNull();
  });
});

// ─── Import tests ─────────────────────────────────────────────────────────────

describe("portable-knowledge — import", () => {
  function makeDoc(entries: ExportDocument["entries"]): ExportDocument {
    return {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      projectCwd: "/some/other/project",
      entries,
    };
  }

  it("imports entries into an empty project", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Imported insight",
        tags: ["decision"],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const result = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    expect(result.total).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.dryRun).toBe(false);

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    expect(existsSync(dbPath)).toBe(true);

    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("dry-run returns expected counts without writing", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Should not be written",
        tags: [],
        confidence: 1,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const result = await importKnowledge(cwd, doc, { dryRun: true, _lcmBaseDir: baseDir });
    expect(result.dryRun).toBe(true);
    expect(result.total).toBe(1);
    // dry-run must return imported: 0 — nothing was actually written
    expect(result.imported).toBe(0);

    // Nothing should be written
    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects unsupported export versions", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const doc = { version: 999, exportedAt: "", projectCwd: "", entries: [] } as any;
    await expect(importKnowledge(cwd, doc, { _lcmBaseDir: baseDir })).rejects.toThrow(
      /Unsupported export version/,
    );
  });

  it("overrides confidence when option is provided", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Override confidence test",
        tags: [],
        confidence: 1.0,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    await importKnowledge(cwd, doc, { confidence: 0.3, _lcmBaseDir: baseDir });

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].confidence).toBe(0.3);
    db.close();
  });

  it("imports multiple entries and returns correct counts", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      { content: "TypeScript is the primary language", tags: ["decision"], confidence: 0.8, createdAt: new Date().toISOString(), sessionId: null },
      { content: "PostgreSQL for the data layer", tags: ["decision"], confidence: 0.9, createdAt: new Date().toISOString(), sessionId: null },
      { content: "React for the frontend", tags: ["decision"], confidence: 0.7, createdAt: new Date().toISOString(), sessionId: null },
    ]);

    const result = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBe(3);
    db.close();
  });

  it("writes meta.json on import so the project is visible to export --all", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    // Import into a brand-new project (no prior meta.json)
    const doc = makeDoc([
      {
        content: "Round-trip test entry",
        tags: ["decision"],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });

    // meta.json must exist so export --all can discover this project
    const projId = toProjectId(cwd);
    const metaPath = join(baseDir, "projects", projId, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.cwd).toBe(cwd);

    // Verify the round-trip: export using the same project directory enumeration
    // that `lcm export --all` uses (scan projects/ for meta.json files).
    const projectsDir = join(baseDir, "projects");
    const discoveredCwds: string[] = [];
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mp = join(projectsDir, entry.name, "meta.json");
      if (!existsSync(mp)) continue;
      try {
        const m = JSON.parse(readFileSync(mp, "utf-8"));
        if (m.cwd) discoveredCwds.push(m.cwd);
      } catch { /* skip */ }
    }

    expect(discoveredCwds).toContain(cwd);

    // Full round-trip: export the imported project and verify the entry is there
    const outFile = join(makeTempDir(), "roundtrip.json");
    const { exportKnowledge } = await import("../src/portable-knowledge.js");
    const exportResult = await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });
    expect(exportResult.exported).toBe(1);

    const exported: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(exported.entries[0].content).toBe("Round-trip test entry");
  });
});
