import type { SummaryStore } from "../store/summary-store.js";
import { wrapCompactionContext } from "../compaction-context.js";
import { fenceContent } from "./content-fence.js";
import { renderContextItems } from "./restore/context-items.js";

export type ContextWindowStatus = "ready" | "empty" | "busy" | "deadline" | "over-budget" | "coverage-unverified" | "capture-unverified" | "excluded" | "no-summarizer" | "summary-failed" | "boundary-scan-limit" | "invalid-request";

export async function readCompactionContext(store: SummaryStore, conversationId: number, request: number | { byteBudget: number; includeItems: true }) {
  const byteBudget = typeof request === "number" ? request : request.byteBudget;
  const includeItems = typeof request !== "number";
  const rows = await store.readContextWindow(conversationId, 0, { complete: true });
  const coverage = await store.readContextCoverage(conversationId, rows);
  const base = { conversationId, byteBudget, ...coverage };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > 1_048_576) return { conversationId, byteBudget, status: "over-budget" as const };
  if (!coverage.valid || coverage.uncoveredMessageIds.length > 0) return { ...base, status: "coverage-unverified" as const };
  if (rows.length === 0) return { ...base, status: "empty" as const };
  const text = wrapCompactionContext(fenceContent(renderContextItems(rows).join("\n\n"), "recent-session-context"));
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > byteBudget) return { ...base, status: "over-budget" as const };
  return { ...base, status: "ready" as const, text, bytes, ...(includeItems ? { items: rows } : {}) };
}
