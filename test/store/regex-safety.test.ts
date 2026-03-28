import { describe, it, expect } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

describe("validateRegex", () => {
  it("returns RegExp for safe patterns", () => {
    expect(validateRegex("hello.*world")).toBeInstanceOf(RegExp);
    expect(validateRegex("\\d{3}-\\d{4}")).toBeInstanceOf(RegExp);
  });

  it("throws for catastrophic backtracking patterns", () => {
    // These strings are test INPUTS to validateRegex() which rejects them.
    // They are never compiled as RegExp literals — CodeQL suppression is correct here.
    // codeql[js/redos]
    const nestedQuantifier = "(a+)+$";
    // codeql[js/redos]
    const repeatedGroup = "(.*a){20}";
    expect(() => validateRegex(nestedQuantifier)).toThrow(/unsafe/i);
    expect(() => validateRegex(repeatedGroup)).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow();
    expect(() => validateRegex("(?P<name>")).toThrow();
  });
});
