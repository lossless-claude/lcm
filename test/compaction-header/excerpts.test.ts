import { describe, expect, it } from "vitest";
import { assembleExcerpts, checkExcerpts } from "../../src/compaction-header/excerpts.js";
import type { ShadowOriginal } from "../../src/daemon/shadow/types.js";

const user = (id: number, text: string): ShadowOriginal => ({ id, seq: id, role: "user", origin: "user", text });
describe("compaction user excerpts", () => {
  it("keeps human text exactly and preserves slash-command arguments while omitting generated rows", () => {
    const originals = [user(1, "  Build the parser.\nKeep the spacing.  "),
      { ...user(2, "assistant proposal"), role: "assistant" },
      { ...user(3, "hidden context"), origin: "other" as const },
      user(4, "<system-reminder>generated instruction</system-reminder>"),
      user(5, "<command-name>/review</command-name>\n<command-args>  Check #42\nwith care.  </command-args>")];
    expect(assembleExcerpts(originals, "cut-a").excerpts).toEqual([
      { id: "u1", rawMessageId: 1, text: "  Build the parser.\nKeep the spacing.  ", spans: [originals[0].text], sources: ["[raw:cut-a:1]"] },
      { id: "u5", rawMessageId: 5, text: "/review\n  Check #42\nwith care.  ", spans: ["/review", "  Check #42\nwith care.  "], sources: ["[raw:cut-a:5]"] },
    ]);
  });
  it("always keeps the first request and directive-like messages above the byte target", () => {
    const originals = [user(1, "Initial question?"), user(2, "Never publish " + "x".repeat(5000)),
      user(3, "old chatter"), user(4, "latest chatter")];
    const selected = assembleExcerpts(originals, "cut-a", { targetBytes: 1 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 2]);
    expect(selected.excerpts[1].text).toBe(originals[1].text);
    expect(selected.omittedIds).toEqual([3, 4]);
    expect(selected.overflowBytes).toBeGreaterThan(5000);
  });
  it("trims older non-directive messages before the latest ones, retaining chronological order", () => {
    const originals = [user(1, "initial?"), user(2, "a".repeat(500)), user(3, "b".repeat(500)), user(4, "recent?")];
    const selected = assembleExcerpts(originals, "cut-a", { targetBytes: 250 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 4]);
    expect(selected.omittedIds).toEqual([2, 3]);
    expect(selected.overflowBytes).toBe(0);
  });
  it("checks excerpt wording against the exact human spans, including slash arguments", () => {
    const originals = [user(1, "Never publish without asking."), user(2, "<command-name>/review</command-name><command-args>  Carefully.  </command-args>")];
    const excerpts = assembleExcerpts(originals, "cut-a").excerpts;
    expect(checkExcerpts(excerpts, originals, "cut-a")).toEqual([]);
    expect(checkExcerpts([{ ...excerpts[0], text: "Publishing is prohibited." }], originals, "cut-a")).toEqual(["u1"]);
    expect(checkExcerpts([{ ...excerpts[1], spans: ["/review", "Carefully."], text: "/review\nCarefully." }], originals, "cut-a")).toEqual(["u2"]);
  });
});
