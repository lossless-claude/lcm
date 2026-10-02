import type { ContextWindowItem } from "../../store/summary-store.js";

/** Summary ids come from the store, independently of generated summary prose. */
export function renderContextItems(rows: readonly ContextWindowItem[]): string[] {
  return rows.map(row => row.itemType === "summary" ? `Summary [${row.summaryId}]:\n${row.content}`
    : `${row.role === "assistant" ? "Assistant" : row.role === "tool" ? "Tool" : row.role === "system" ? "System" : "User"}:\n${row.content}`);
}
