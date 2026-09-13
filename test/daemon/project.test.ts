import { describe, it, expect } from "vitest";
import { projectId, projectDbPath, projectMetaPath } from "../../src/daemon/project.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());

describe("projectId", () => {
  it("returns sha256 hex of absolute path", () => expect(projectId("/foo")).toMatch(/^[a-f0-9]{64}$/));
  it("is deterministic", () => expect(projectId("/foo")).toBe(projectId("/foo")));
  it("differs for different paths", () => expect(projectId("/foo")).not.toBe(projectId("/bar")));
});

describe("projectDbPath", () => {
  it("returns path under .lossless-claude/projects/<id>/db.sqlite", () => {
    const p = projectDbPath("/foo/bar", paths);
    expect(p).toContain("projects");
    expect(p).toContain("db.sqlite");
  });
});

describe("projectMetaPath", () => {
  it("returns path ending in meta.json", () => {
    expect(projectMetaPath("/foo", paths)).toContain("meta.json");
  });
});
