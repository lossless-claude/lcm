import { describe, expect, it } from "vitest";
import { assembleExcerpts, checkExcerpts } from "../../src/compaction-header/excerpts.js";
import type { ShadowOriginal } from "../../src/daemon/shadow/types.js";

const user = (id: number, text: string): ShadowOriginal => ({ id, seq: id, role: "user", origin: "user", text });
describe("compaction user excerpts", () => {
  it("excludes the exact tool-use interruption marker from user words", () => {
    const rows = [user(1, "[Request interrupted by user for tool use]"), user(2, "Keep working.")];
    expect(assembleExcerpts(rows, "cut-a").excerpts.map(row => row.rawMessageId)).toEqual([2]);
  });
  it.each(["<bash-stdout>output</bash-stdout>", "<bash-stderr>error</bash-stderr>", "<bash-input>echo hi</bash-input>", "[Request interrupted by user]"])("excludes non-assistant-directed shell/interruption rows (%s)", text => {
    const rows = [user(1, text), user(2, "Leave production untouched.")];
    expect(assembleExcerpts(rows, "cut-a").excerpts.map(row => row.rawMessageId)).toEqual([2]);
  });
  it.each(["Caveat: never publish this branch.", "Base directory for this skill needs changing.", "This session is being continued deliberately."])("keeps human prose regardless of its first words (%s)", text => {
    expect(assembleExcerpts([user(1, text)], "cut-a").excerpts[0]?.text).toBe(text);
  });
  it("uses structural metadata and tags to exclude generated rows", () => {
    const rows = [{ ...user(1, "not human"), isMeta: true }, user(2, "<local-command-stdout>generated</local-command-stdout>"),
      user(3, "<task-notification>generated</task-notification>"), user(4, "Caveat: leave production untouched.")];
    expect(assembleExcerpts(rows, "cut-a").excerpts.map(row => row.rawMessageId)).toEqual([4]);
  });
  it("retains every human message even when an instruction has no classifier keyword", () => {
    const originals = [user(1, "Initial request " + "x".repeat(5000)), user(2, "Leave production untouched.")];
    const selected = assembleExcerpts(originals, "cut-a", { messageTargetBytes: 4096 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 2]);
    expect(selected.excerpts[1].text).toBe("Leave production untouched.");
  });
  it("middle-elides an oversized message with a raw-row marker and exact Unicode head/tail", () => {
    const text = "HEAD🙂 " + "middle🙂 ".repeat(100) + " TAIL🙂";
    const selected = assembleExcerpts([user(7, text)], "cut-a", { messageTargetBytes: 160 });
    const excerpt = selected.excerpts[0];
    expect(excerpt.text.startsWith("HEAD🙂 ")).toBe(true);
    expect(excerpt.text.endsWith(" TAIL🙂")).toBe(true);
    expect(excerpt.text).toContain("[middle elided from [raw:cut-a:7]]");
    expect(excerpt.text).not.toContain(text);
    expect(selected.elidedIds).toEqual([7]);
    expect(checkExcerpts(selected.excerpts, [user(7, text)], "cut-a")).toEqual([]);
  });
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
  it("keeps every human row while marking only middle-elided messages", () => {
    const originals = [user(1, "Initial question?"), user(2, "Never publish " + "x".repeat(5000)),
      user(3, "old chatter"), user(4, "latest chatter")];
    const selected = assembleExcerpts(originals, "cut-a", { messageTargetBytes: 4096 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 2, 3, 4]);
    expect(selected.excerpts[1].text).toContain("[middle elided from [raw:cut-a:2]]");
    expect(selected.elidedIds).toEqual([2]);
  });
  it("keeps short human messages in chronological order without aggregate trimming", () => {
    const originals = [user(1, "initial?"), user(2, "a".repeat(500)), user(3, "b".repeat(500)), user(4, "recent?")];
    const selected = assembleExcerpts(originals, "cut-a", { messageTargetBytes: 4096 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 2, 3, 4]);
    expect(selected.elidedIds).toEqual([]);
  });
  it("checks excerpt wording against the exact human spans, including slash arguments", () => {
    const originals = [user(1, "Never publish without asking."), user(2, "<command-name>/review</command-name><command-args>  Carefully.  </command-args>")];
    const excerpts = assembleExcerpts(originals, "cut-a").excerpts;
    expect(checkExcerpts(excerpts, originals, "cut-a")).toEqual([]);
    expect(checkExcerpts([{ ...excerpts[0], text: "Publishing is prohibited." }], originals, "cut-a")).toEqual(["u1"]);
    expect(checkExcerpts([{ ...excerpts[1], spans: ["/review", "Carefully."], text: "/review\nCarefully." }], originals, "cut-a")).toEqual(["u2"]);
  });
  it("omits command markup nested inside a generated reminder", () => {
    const text = "<system-reminder><command-name>/review</command-name><command-args>Never deploy</command-args></system-reminder>";
    expect(assembleExcerpts([user(1, text)], "cut-a").excerpts).toEqual([]);
  });
  it.each(["Don’t publish this patch.", "I authorize deployment.", "<command-name>  /review</command-name><command-args>details</command-args>"])("protects directive or permission wording without a hard size cap (%s)", text => {
    const selected = assembleExcerpts([user(1, "first question?"), user(2, text)], "cut-a", { messageTargetBytes: 4096 });
    expect(selected.excerpts.map(row => row.rawMessageId)).toEqual([1, 2]);
  });
});
