import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { validateCwd } from "../../src/daemon/validate-cwd.js";

// On macOS /tmp is a symlink to /private/tmp; resolve once for cross-platform assertions.
const REAL_TMP = realpathSync("/tmp");

describe("validateCwd", () => {
  it("resolves trailing slashes", () => {
    const result = validateCwd("/tmp/");
    expect(result).toBe(REAL_TMP);
  });

  it("resolves .. components", () => {
    const result = validateCwd("/tmp/foo/../");
    expect(result).toBe(REAL_TMP);
  });

  it("throws on relative path", () => {
    expect(() => validateCwd("relative/path")).toThrow("absolute path");
  });

  it("throws on empty string", () => {
    expect(() => validateCwd("")).toThrow();
  });

  it("throws if path does not exist", () => {
    expect(() => validateCwd("/nonexistent/path/that/does/not/exist")).toThrow();
  });
});
