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
    expect(block).toContain("an id suffixed @<projectId> came from another project");
    expect(block).toContain("pass that as projectId to lcm_describe/lcm_expand");
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
    const hint = "x".repeat(40);
    // Exactly the bare rendering: the same candidate fits without a project
    // suffix and must not fit with one, so the assertion below can only pass
    // if the suffix is actually counted.
    const totalByteBudget = Buffer.byteLength(buildMemoryContext([hint], ["id-1"])!, "utf8");

    const bare = selectMemoryHintsWithinBudget([{ id: "id-1", hint }], { ...budget, totalByteBudget });
    expect(bare.hints).toEqual([hint]);
    expect(bare.droppedForBudget).toBe(0);

    const suffixed = selectMemoryHintsWithinBudget(
      [{ id: "id-1", hint, projectId: longProjectId }],
      { ...budget, totalByteBudget },
    );
    expect(suffixed.hints).toHaveLength(0);
    expect(suffixed.droppedForBudget).toBe(1);
  });
});
