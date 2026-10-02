import { readFileSync } from "node:fs";
import { digest } from "../../daemon/shadow/types.js";

/** Phase 1 does not call a model or assign continuation quality. */
export function continuationStub() {
  const rubric = readFileSync(new URL("./continuation-rubric.yaml", import.meta.url), "utf8");
  return { status: "not-run/phase-2" as const, rubricVersion: 1, rubricHash: digest(rubric) };
}
