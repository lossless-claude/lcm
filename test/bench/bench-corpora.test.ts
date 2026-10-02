import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { corpusConfigPath, discoverCorpora, groupCorpora, readCorpusConfig } from "../../scripts/bench-corpora.mts";
import { projectDir, projectId } from "../../src/daemon/project.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";

let root: string;
let paths: LcmPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcm-bench-corpora-"));
  paths = createLcmPaths(join(root, "lcm"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const project = (...parts: string[]) => join(root, "work", ...parts);
/** Above the size below which discovery ignores a project database. */
const DISCOVERABLE_DB_BYTES = 3 * 1024 * 1024;

/** An ingested project large enough to be discovered, whose meta.json names `metaCwd`. */
function ingest(cwd: string, metaCwd = cwd): void {
  const dir = projectDir(cwd, paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: metaCwd }));
  writeFileSync(join(dir, "db.sqlite"), "");
  truncateSync(join(dir, "db.sqlite"), DISCOVERABLE_DB_BYTES);
}

function writeConfig(text: string): string {
  mkdirSync(paths.home, { recursive: true });
  const file = corpusConfigPath(paths);
  writeFileSync(file, text);
  return file;
}

describe("readCorpusConfig", () => {
  it("holds nothing out and excludes nothing without a file", () => {
    const config = readCorpusConfig(corpusConfigPath(paths), paths);
    expect([...config.holdout, ...config.exclude]).toEqual([]);
  });

  it("keys project paths on disk, and ingested projects no longer on disk, by project id", () => {
    mkdirSync(project("held"), { recursive: true });
    ingest(project("removed"));
    const config = readCorpusConfig(writeConfig(JSON.stringify({ holdout: [project("held")], exclude: [project("removed")] })), paths);
    expect([...config.holdout]).toEqual([projectId(project("held"))]);
    expect([...config.exclude]).toEqual([projectId(project("removed"))]);
  });

  it.each([
    ["an unknown key", () => JSON.stringify({ excludes: ["/x"] }), /unknown key "excludes"/],
    ["a value that is not a list", () => JSON.stringify({ exclude: "/x" }), /"exclude" must be a list of absolute project paths/],
    ["an empty entry", () => JSON.stringify({ holdout: [""] }), /"holdout" must be a list of absolute project paths/],
    ["a relative path", () => JSON.stringify({ exclude: ["work/private"] }), /"exclude" must be a list of absolute project paths/],
    ["an unexpanded home", () => JSON.stringify({ exclude: ["~/private"] }), /"exclude" must be a list of absolute project paths/],
    ["a path that matches no project", () => JSON.stringify({ exclude: [project("typo")] }), /neither on disk nor an ingested project/],
    ["a list at the top", () => JSON.stringify(["/x"]), /must hold a JSON object/],
    ["malformed JSON", () => "{", /JSON/],
  ])("stops on %s", (_case, text, message) => {
    expect(() => readCorpusConfig(writeConfig(text()), paths)).toThrow(message);
  });
});

describe("discoverCorpora", () => {
  it("skips an excluded project before reading its meta.json", async () => {
    ingest(project("kept"));
    // Read, this meta.json would list "kept" a second time.
    ingest(project("private"), project("kept"));
    expect(await discoverCorpora(paths, new Set([projectId(project("private"))]))).toEqual([project("kept")]);
  });

  it("drops an excluded project named in LCM_BENCH_CORPORA", async () => {
    const configured = [project("kept"), project("private")].join(delimiter);
    expect(await discoverCorpora(paths, new Set([projectId(project("private"))]), configured)).toEqual([project("kept")]);
  });

  it("excludes a project that is also held out", async () => {
    const both = new Set([projectId(project("private"))]);
    const corpora = await discoverCorpora(paths, both, [project("held"), project("private")].join(delimiter));
    expect(groupCorpora(corpora, "holdout", new Set([...both, projectId(project("held"))]))).toEqual([project("held")]);
  });
});

describe("groupCorpora", () => {
  const corpora = () => [project("a", "app"), project("b", "app"), project("other")];

  it("splits by project rather than directory name, with no corpus on both sides", () => {
    const holdout = new Set([projectId(project("a", "app"))]);
    expect(groupCorpora(corpora(), "holdout", holdout)).toEqual([project("a", "app")]);
    expect(groupCorpora(corpora(), "tune", holdout)).toEqual([project("b", "app"), project("other")]);
    expect(groupCorpora(corpora(), "all", holdout)).toEqual(corpora());
  });

  it("tunes on every corpus and refuses a holdout run when nothing is held out", () => {
    expect(groupCorpora(corpora(), "tune", new Set())).toEqual(corpora());
    expect(() => groupCorpora(corpora(), "holdout", new Set())).toThrow(/lists no "holdout" project/);
  });
});
