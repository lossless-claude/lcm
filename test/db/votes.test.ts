import { describe, expect, it } from "vitest";
import { isSignalTagged, isVoteRecord, parseVote, singleMemoryIdTag, voteTagsOf } from "../../src/db/votes.js";

describe("singleMemoryIdTag", () => {
  it("accepts exactly one non-empty target", () => {
    expect(singleMemoryIdTag(["signal:memory_used", "memory_id:abc"])).toBe("abc");
  });

  it.each([
    [["signal:memory_used"]],
    [["signal:memory_used", "memory_id:"]],
    [["signal:memory_used", "memory_id:a", "memory_id:b"]],
  ])("rejects missing, empty, and duplicate targets", (tags) => {
    expect(singleMemoryIdTag(tags)).toBeNull();
  });
});

describe("isSignalTagged", () => {
  it("recognizes any signal: tag", () => {
    expect(isSignalTagged(["signal:memory_used", "memory_id:abc"])).toBe(true);
    expect(isSignalTagged(["signal:memory_vote", "vote:+1", "memory_id:abc"])).toBe(true);
    expect(isSignalTagged(["type:decision", "project:lcm"])).toBe(false);
  });
});

describe("isVoteRecord", () => {
  it("is true only for signal:memory_vote", () => {
    expect(isVoteRecord(["signal:memory_vote"])).toBe(true);
    expect(isVoteRecord(["signal:memory_used"])).toBe(false);
    expect(isVoteRecord([])).toBe(false);
  });
});

describe("parseVote", () => {
  it("parses a well-formed +1", () => {
    const result = parseVote(["signal:memory_vote", "vote:+1", "memory_id:abc-123"], "Verified in file.ts line 10");
    expect(result).toEqual({ memoryId: "abc-123", direction: "+1", reason: "Verified in file.ts line 10" });
  });

  it("parses a well-formed -1", () => {
    const result = parseVote(["signal:memory_vote", "vote:-1", "memory_id:abc-123"], "file.ts no longer exists");
    expect(result).toEqual({ memoryId: "abc-123", direction: "-1", reason: "file.ts no longer exists" });
  });

  it("rejects a vote with no memory_id tag", () => {
    const result = parseVote(["signal:memory_vote", "vote:+1"], "reason");
    expect(result).toEqual({ error: expect.stringContaining("memory_id") });
  });

  it("rejects a vote with two memory_id tags", () => {
    const result = parseVote(["signal:memory_vote", "vote:+1", "memory_id:a", "memory_id:b"], "reason");
    expect(result).toEqual({ error: expect.stringContaining("memory_id") });
  });

  it("rejects a vote with no vote: tag", () => {
    const result = parseVote(["signal:memory_vote", "memory_id:a"], "reason");
    expect(result).toEqual({ error: expect.stringContaining("vote:") });
  });

  it("rejects a vote with two vote: tags", () => {
    const result = parseVote(["signal:memory_vote", "vote:+1", "vote:-1", "memory_id:a"], "reason");
    expect(result).toEqual({ error: expect.stringContaining("vote:") });
  });

  it("rejects an unrecognized vote value", () => {
    const result = parseVote(["signal:memory_vote", "vote:0", "memory_id:a"], "reason");
    expect(result).toEqual({ error: expect.stringContaining('"+1" or "-1"') });
  });

  it("rejects a +1 with an empty reason", () => {
    const result = parseVote(["signal:memory_vote", "vote:+1", "memory_id:a"], "   ");
    expect(result).toEqual({ error: expect.stringContaining("evidence") });
  });

  it("rejects a -1 with an empty reason", () => {
    const result = parseVote(["signal:memory_vote", "vote:-1", "memory_id:a"], "");
    expect(result).toEqual({ error: expect.stringContaining("contradicts") });
  });
});

describe("voteTagsOf", () => {
  it("extracts memoryId and direction from stored tags", () => {
    expect(voteTagsOf(["signal:memory_vote", "vote:-1", "memory_id:xyz"])).toEqual({ memoryId: "xyz", direction: "-1" });
  });

  it("returns null when either tag is missing", () => {
    expect(voteTagsOf(["signal:memory_vote", "vote:-1"])).toBeNull();
    expect(voteTagsOf(["signal:memory_vote", "memory_id:xyz"])).toBeNull();
  });
});
