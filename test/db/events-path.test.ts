import { describe, it, expect } from "vitest";
import { eventsDbPath, eventsDir } from "../../src/db/events-path.js";
import { join } from "node:path";
import { lcmHome } from "../../src/lcm-home.js";

describe("eventsDbPath", () => {
  it("returns a path under the lcm home's events directory", () => {
    const result = eventsDbPath("/some/project");
    expect(result.startsWith(join(eventsDir(), ""))).toBe(true);
    expect(result.endsWith(".db")).toBe(true);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project");
    const b = eventsDbPath("/some/project");
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a");
    const b = eventsDbPath("/project/b");
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("sits directly under the lcm home", () => {
    expect(eventsDir()).toBe(join(lcmHome(), "events"));
  });
});
