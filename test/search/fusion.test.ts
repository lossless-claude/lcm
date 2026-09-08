import { describe, it, expect } from "vitest";
import { fuseHistoryBySession, type RankedHistoryHit } from "../../src/search/native-history.js";

// Summaries are given a far better rank than any message, so a summary that
// fails to surface has been hidden by the fusion structure, not outscored.
const message = (session: string, i: number): RankedHistoryHit =>
  ({ messageId: i, conversationId: i, sessionId: session, rank: -50 + i }) as RankedHistoryHit;
const summary = (session: string, i: number): RankedHistoryHit =>
  ({ summaryId: `s${i}`, conversationId: i, sessionId: session, rank: -99 }) as RankedHistoryHit;

const sessions = (n: number) => Array.from({ length: n }, (_, i) => `sess-${i}`);
const oneEach = (n: number) => {
  const names = sessions(n);
  return {
    messages: names.map((s, i) => message(s, i)),
    summaries: names.map((s, i) => summary(s, i)),
  };
};
const countSummaries = (hits: RankedHistoryHit[]) => hits.filter((h) => "summaryId" in h).length;

describe("fuseHistoryBySession", () => {
  it.each([
    [10, 10, 4],
    [5, 5, 2],
    [9, 10, 4],
    [3, 10, 3],
    [1, 10, 1],
  ])("surfaces summaries with %i sessions at limit %i", (n, limit, expected) => {
    const { messages, summaries } = oneEach(n);
    // Before the reserved share, every case where sessions >= limit returned zero.
    expect(countSummaries(fuseHistoryBySession(messages, summaries, limit))).toBe(expected);
  });

  it("spends a single slot on the message, as callers already expect", () => {
    const { messages, summaries } = oneEach(3);
    const hits = fuseHistoryBySession(messages, summaries, 1);
    expect(hits).toHaveLength(1);
    expect("messageId" in hits[0]).toBe(true);
  });

  it("gives the reserved share back to messages when no summary matched", () => {
    const { messages } = oneEach(4);
    const hits = fuseHistoryBySession(messages, [], 4);
    expect(hits).toHaveLength(4);
    expect(countSummaries(hits)).toBe(0);
  });

  it("lets summaries take the remainder when messages underfill", () => {
    const summaries = sessions(5).map((s, i) => summary(s, i));
    const hits = fuseHistoryBySession([message("sess-0", 0)], summaries, 5);
    // One message exists; the other four slots must not be left empty.
    expect(hits).toHaveLength(5);
    expect(countSummaries(hits)).toBe(4);
  });

  it("returns only summaries when no message matched", () => {
    const summaries = sessions(3).map((s, i) => summary(s, i));
    expect(fuseHistoryBySession([], summaries, 5)).toHaveLength(3);
  });

  it("keeps a session's message ahead of its own summary", () => {
    const hits = fuseHistoryBySession([message("a", 1)], [summary("a", 1)], 5);
    expect(hits.map((h) => ("messageId" in h ? "message" : "summary"))).toEqual(["message", "summary"]);
  });

  it("still spreads a small limit across sessions before taking second hits", () => {
    const messages = [message("a", 1), message("a", 2), message("b", 3)];
    const hits = fuseHistoryBySession(messages, [], 2);
    expect(new Set(hits.map((h) => h.sessionId))).toEqual(new Set(["a", "b"]));
  });

  it("never exceeds the limit and returns nothing at limit 0", () => {
    const { messages, summaries } = oneEach(6);
    expect(fuseHistoryBySession(messages, summaries, 0)).toEqual([]);
    expect(fuseHistoryBySession(messages, summaries, 3)).toHaveLength(3);
  });
});
