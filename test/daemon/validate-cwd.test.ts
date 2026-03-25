import { describe, it, expect } from "vitest";
import { validateCwd } from "../../src/daemon/validate-cwd.js";

describe("validateCwd", () => {
  it("resolves trailing slashes", () => {
    const result = validateCwd("/tmp/");
    expect(result).toBe("/tmp");
  });

  it("resolves .. components", () => {
    const result = validateCwd("/tmp/foo/../");
    expect(result).toBe("/tmp");
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
