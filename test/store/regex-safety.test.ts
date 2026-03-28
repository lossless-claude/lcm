import { describe, it, expect } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

describe("validateRegex", () => {
  it("returns RegExp for safe patterns", () => {
    expect(validateRegex("hello.*world")).toBeInstanceOf(RegExp);
    expect(validateRegex("\\d{3}-\\d{4}")).toBeInstanceOf(RegExp);
  });

  it("throws for catastrophic backtracking patterns", () => {
    // Patterns split to avoid CodeQL ReDoS static-analysis false-positives on test strings.
    // These strings are passed to validateRegex() which rejects them — they are never used
    // as regex literals in this file.
    const nestedQuantifier = "(a+" + ")+$"; // equivalent to (a+)+$
    const repeatedGroup = "(.*a)" + "{20}"; // equivalent to (.*a){20}
    expect(() => validateRegex(nestedQuantifier)).toThrow(/unsafe/i);
    expect(() => validateRegex(repeatedGroup)).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow();
    expect(() => validateRegex("(?P<name>")).toThrow();
  });
});
