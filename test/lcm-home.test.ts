// test/lcm-home.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { lcmHome, lcmPath } from "../src/lcm-home.js";

const DEFAULT = join(homedir(), ".lossless-claude");

afterEach(() => { delete process.env.LCM_HOME; });

describe("lcmHome", () => {
  it("defaults to the lcm directory under the user's home", () => {
    expect(lcmHome({} as NodeJS.ProcessEnv)).toBe(DEFAULT);
  });

  it("uses LCM_HOME when it is set", () => {
    expect(lcmHome({ LCM_HOME: "/tmp/sandbox" } as NodeJS.ProcessEnv)).toBe("/tmp/sandbox");
  });

  it("ignores an empty or blank LCM_HOME", () => {
    expect(lcmHome({ LCM_HOME: "" } as NodeJS.ProcessEnv)).toBe(DEFAULT);
    expect(lcmHome({ LCM_HOME: "   " } as NodeJS.ProcessEnv)).toBe(DEFAULT);
  });

  it("reads the variable on every call, so a test can set and clear it", () => {
    expect(lcmHome()).toBe(DEFAULT);
    process.env.LCM_HOME = "/tmp/sandbox";
    expect(lcmHome()).toBe("/tmp/sandbox");
    delete process.env.LCM_HOME;
    expect(lcmHome()).toBe(DEFAULT);
  });
});

describe("lcmPath", () => {
  it("joins segments onto the lcm home", () => {
    expect(lcmPath("daemon.token")).toBe(join(DEFAULT, "daemon.token"));
    expect(lcmPath("projects", "abc", "db.sqlite"))
      .toBe(join(DEFAULT, "projects", "abc", "db.sqlite"));
  });

  it("follows the override", () => {
    process.env.LCM_HOME = "/tmp/sandbox";
    expect(lcmPath("config.json")).toBe("/tmp/sandbox/config.json");
  });

  it("returns the home itself with no segments", () => {
    expect(lcmPath()).toBe(DEFAULT);
  });
});
