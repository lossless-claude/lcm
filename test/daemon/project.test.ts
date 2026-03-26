import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { projectId, projectDbPath, projectMetaPath, projectDir } from "../../src/daemon/project.js";

describe("projectId", () => {
  it("returns sha256 hex of absolute path", () => expect(projectId("/foo")).toMatch(/^[a-f0-9]{64}$/));
  it("is deterministic", () => expect(projectId("/foo")).toBe(projectId("/foo")));
  it("differs for different paths", () => expect(projectId("/foo")).not.toBe(projectId("/bar")));
});

describe("projectDbPath", () => {
  it("returns path under .lossless-claude/projects/<id>/db.sqlite", () => {
    const p = projectDbPath("/foo/bar");
    expect(p).toContain("projects");
    expect(p).toContain("db.sqlite");
  });
});

describe("projectMetaPath", () => {
  it("returns path ending in meta.json", () => {
    expect(projectMetaPath("/foo")).toContain("meta.json");
  });
});

describe("LCM_DATA_DIR override", () => {
  let savedDataDir: string | undefined;

  beforeEach(() => { savedDataDir = process.env.LCM_DATA_DIR; });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.LCM_DATA_DIR;
    else process.env.LCM_DATA_DIR = savedDataDir;
  });

  it("projectDir uses LCM_DATA_DIR when set", () => {
    const customBase = join("/", "custom", "data");
    process.env.LCM_DATA_DIR = customBase;
    expect(projectDir("/foo")).toContain(customBase);
  });

  it("projectDir falls back to ~/.lossless-claude when unset", () => {
    delete process.env.LCM_DATA_DIR;
    expect(projectDir("/foo")).toContain(".lossless-claude");
  });

  it("projectDbPath reflects LCM_DATA_DIR", () => {
    const customBase = join("/", "custom", "data");
    process.env.LCM_DATA_DIR = customBase;
    expect(projectDbPath("/foo")).toContain(customBase);
    expect(projectDbPath("/foo")).toContain("db.sqlite");
  });
});
