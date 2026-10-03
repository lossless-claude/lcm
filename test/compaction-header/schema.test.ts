import { describe, expect, it } from "vitest";
import { validCompactionHeader } from "../../hooks/compaction-header-schema.js";

import { workingHeader as header } from "./fixtures.js";
describe("versioned working-state header", () => {
  it("accepts the nine sections with provenance, scoped citations, supersession and fixes", () => {
    expect(validCompactionHeader(header())).toBe(true);
  });
  it.each(["missing section", "missing source", "restated instruction", "non-excerpt instruction", "missing provenance", "invalid state", "malformed supersession"])("refuses %s", defect => {
    const value: any = header();
    const mutations: Record<string, () => void> = {
      "missing section": () => { delete value.procedure; },
      "missing source": () => { value.intent[0].sources = []; },
      "restated instruction": () => { value.instructionsInForce[0].text = "Always fix parsers"; },
      "non-excerpt instruction": () => { value.instructionsInForce[0].sources = ["[sum:sum_old]"]; },
      "missing provenance": () => { delete value.taskState[0].provenance; },
      "invalid state": () => { value.taskState[0].status = "almost done"; },
      "malformed supersession": () => { value.decisions[0].supersedes = ["invented"] },
    };
    mutations[defect](); expect(validCompactionHeader(value)).toBe(false);
  });
});
