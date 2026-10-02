/** Distinct from source/parser failures and summary-provider failures. */
export class CompactionDeadlineError extends Error {
  constructor() {
    super("Compaction deadline exceeded");
    this.name = "CompactionDeadlineError";
  }
}
