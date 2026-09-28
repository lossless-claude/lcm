import { describe, expect, it } from "vitest";
import { compareStoredMessageContent } from "../src/message-content.js";

const scrubKeys = (text: string) => text.replace(/sk-\w+/g, "[REDACTED]");

describe("compareStoredMessageContent", () => {
  it("classifies a row cut at the NUL as cut even when the redaction marker could absorb the rest", () => {
    // The stored row holds only what preceded the NUL, already redacted.
    expect(compareStoredMessageContent("[REDACTED]", "sk-abc\u0000tail", scrubKeys)).toBe("cut");
  });

  it("matches a whole row stored with the NUL normalized", () => {
    expect(compareStoredMessageContent("[REDACTED]�tail", "sk-abc\u0000tail", scrubKeys)).toBe("full");
  });

  it("keeps the removed-pattern allowance for text without a NUL", () => {
    expect(compareStoredMessageContent("token [REDACTED] end", "token abc123 end", (text) => text)).toBe("full");
  });
});
