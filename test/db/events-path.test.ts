import { describe, it, expect } from "vitest";
import { eventsDbPath, eventsDir } from "../../src/db/events-path.js";
import { join } from "node:path";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());

describe("eventsDbPath", () => {
  it("returns a path under the lcm home's events directory", () => {
    const result = eventsDbPath("/some/project", paths);
    expect(result.startsWith(join(eventsDir(paths), ""))).toBe(true);
    expect(result.endsWith(".db")).toBe(true);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project", paths);
    const b = eventsDbPath("/some/project", paths);
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a", paths);
    const b = eventsDbPath("/project/b", paths);
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("sits directly under the lcm home", () => {
    expect(eventsDir(paths)).toBe(join(lcmHome(), "events"));
  });
});
