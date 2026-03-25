import { describe, it, expect } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

describe("validateRegex", () => {
  it("returns RegExp for safe patterns", () => {
    expect(validateRegex("hello.*world")).toBeInstanceOf(RegExp);
    expect(validateRegex("\\d{3}-\\d{4}")).toBeInstanceOf(RegExp);
  });

  it("throws for catastrophic backtracking patterns", () => {
    expect(() => validateRegex("(a+)+$")).toThrow(/unsafe/i);
    expect(() => validateRegex("(.*a){20}")).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow();
    expect(() => validateRegex("(?P<name>")).toThrow();
  });
});
