import { describe, expect, it } from "vitest";
import { prepareHeaderJob, renderCompactionDocument } from "../../src/daemon/shadow/header-job.js";
import { workingHeader } from "./fixtures.js";
import type { ContextWindowItem } from "../../src/store/summary-store.js";

const summary = (ordinal: number, id: string, content: string): ContextWindowItem => ({ ordinal, itemType: "summary", summaryId: id, role: null, content });
const raw: ContextWindowItem = { ordinal: 2, itemType: "message", summaryId: null, messageId: 1, role: "user", content: "Fix parser.ts. Run npm test." };
const input = () => ({ cutId: "cut-a", instructions: "For this PR only.",
  originals: [{ id: 1, seq: 0, role: "user", origin: "user" as const, text: "Fix parser.ts. Run npm test." }],
  window: [summary(0, "sum_old", "Earlier format failed"), summary(1, "sum_new", "Parser fix in progress"), raw],
  tail: [{ role: "user" as const, text: raw.content, handle: "h1" }],
  engineMessages: [{ role: "user" as const, text: raw.content, handle: "h1" }],
});
describe("daemon compaction header job", () => {
  it("keeps every human message when the document overflows, without classifier-based removal", () => {
    const source = input();
    source.originals[0].text = "Initial request " + "x".repeat(5000);
    source.originals.push({ id: 2, seq: 1, role: "user", origin: "user", text: "Leave production untouched." });
    const document = renderCompactionDocument(prepareHeaderJob(source), workingHeader(), { targetBytes: 1 });
    expect(document.text).toContain("Leave production untouched.");
    expect(document.overflowBytes).toBeGreaterThan(1);
    expect(document.elidedExcerptIds).not.toContain(2);
  });
  it("renders common extraction rules with excerpts, scope and addressed complete-window/tail evidence", () => {
    const job = prepareHeaderJob(input());
    expect(job.completePrompt).toContain("[excerpt:u1]");
    expect(job.completePrompt).toContain("[sum:sum_old]");
    expect(job.completePrompt).toContain("[raw:cut-a:1]");
    expect(job.completePrompt).toContain("For this PR only.");
    expect(job.completePrompt).toContain("instructionsInForce");
    expect(job.completePrompt).toContain("procedure");
    expect(job.completePrompt).toContain("750 words is a target");
    expect(job.completePrompt).toContain("never comes first");
    expect(job.forkPrompt).not.toContain("Earlier format failed");
    expect(job.forkPrompt).not.toContain("Parser fix in progress");
    expect(job.forkPrompt).toContain("[excerpt:u1]");
    expect(job.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepareHeaderJob(input()).promptHash).toBe(job.promptHash);
  });
  it("renders excerpts, header, window and engine tail in that order", () => {
    const job = prepareHeaderJob(input());
    const document = renderCompactionDocument(job, workingHeader());
    expect(document.text.indexOf("user's own words")).toBeLessThan(document.text.indexOf("Current intent"));
    expect(document.text.indexOf("Errors and fixes")).toBeLessThan(document.text.indexOf("[sum:sum_old]" , document.text.indexOf("## Window")));
    expect(document.text.indexOf("## Window")).toBeLessThan(document.text.indexOf("## Engine tail"));
    expect(document.headerWordTarget).toBe(750);
    expect(document.omittedSummaryIds).toEqual([]);
  });
  it("yields oldest summaries first, preserving verbatim instructions and the raw remainder above target", () => {
    const source = input(); source.window[0].content = "o".repeat(1000); source.window[1].content = "n".repeat(1000);
    source.originals[0].text = "Never publish " + "x".repeat(5000);
    const job = prepareHeaderJob(source);
    const document = renderCompactionDocument(job, workingHeader(), { targetBytes: 500 });
    expect(document.omittedSummaryIds).toEqual(["sum_old", "sum_new"]);
    expect(document.text).toContain("[middle elided from [raw:cut-a:1]]");
    expect(document.text).toContain("## Engine tail");
    expect(document.overflowBytes).toBe(document.bytes - document.targetBytes);
    expect(document.bytes).toBeGreaterThan(document.targetBytes);
  });
  it("refuses tail text or handles that conflict with the frozen engine input", () => {
    const source = input(); source.tail[0].text = "after-cut evidence";
    expect(() => prepareHeaderJob(source)).toThrow("conflict");
  });
  it("yields the window before trimming non-directive excerpts", () => {
    const source = input();
    source.originals.push({ id: 2, seq: 1, role: "user", origin: "user", text: "o".repeat(8000) });
    source.window[0].content = "s".repeat(12000);
    const job = prepareHeaderJob(source), document = renderCompactionDocument(job, workingHeader(), { targetBytes: 12000 });
    expect(document.omittedSummaryIds).toEqual(["sum_old"]);
    expect(document.text).toContain("[middle elided from [raw:cut-a:2]]");
  });
});
