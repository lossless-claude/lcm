import { describe, expect, it } from "vitest";
import { buildMemoryContext, selectMemoryHintsWithinBudget } from "../../src/hooks/memory-context.js";

describe("buildMemoryContext", () => {
  it("renders a bare id when no project is given", () => {
    const block = buildMemoryContext(["a hint"], ["id-1"]);
    expect(block).toContain("<!-- surfaced-memory-ids: id-1 -->");
  });

  it("suffixes an id with its project when one is given", () => {
    const block = buildMemoryContext(["local", "sibling"], ["id-1", "id-2"], [null, "proj-abc"]);
    expect(block).toContain("<!-- surfaced-memory-ids: id-1,id-2@proj-abc -->");
  });

  it("documents the id@projectId form in the intro", () => {
    const block = buildMemoryContext(["a hint"], ["id-1"], ["proj-abc"]);
    expect(block).toMatch(/projectId.*lcm_describe|lcm_expand/);
  });
});

describe("selectMemoryHintsWithinBudget with cross-project candidates", () => {
  const budget = {
    totalByteBudget: 10_000,
    reservedForLearningInstruction: 0,
    learningInstructionBytes: 0,
    maxEmitted: 10,
    dedupMinPrefix: 20,
  };

  it("carries each candidate's project through to the selection and the rendered block", () => {
    const selection = selectMemoryHintsWithinBudget(
      [
        { id: "local-id", hint: "a local decision" },
        { id: "sibling-id", hint: "a sibling decision", projectId: "sibling-project" },
      ],
      budget,
    );

    expect(selection.ids).toEqual(["local-id", "sibling-id"]);
    expect(selection.projectIds).toEqual([null, "sibling-project"]);

    const block = buildMemoryContext(selection.hints, selection.ids, selection.projectIds);
    expect(block).toContain("local-id,sibling-id@sibling-project");
  });

  it("counts the project suffix against the byte budget", () => {
    const longProjectId = "p".repeat(64);
    const tight = selectMemoryHintsWithinBudget(
      [{ id: "id-1", hint: "x".repeat(40), projectId: longProjectId }],
      { ...budget, totalByteBudget: 30 },
    );

    // Too small to fit hint + id + the 64-byte project suffix; must be dropped, not
    // silently emitted under-budget.
    expect(tight.hints).toHaveLength(0);
    expect(tight.droppedForBudget).toBe(1);
  });
});
