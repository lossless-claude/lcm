import { retireSessionBudget, SessionOutputBudget, type BudgetLease } from "./model-budget.js";

/** Shadow reservations and charges never reduce or block ordinary summaries. */
class ShadowOutputBudget extends SessionOutputBudget {
  override reserveFork(): BudgetLease | null {
    return this.snapshot().usageUnknown ? null : super.reserveFork();
  }
  override async reserveComplete(maxTokens: number, count = 1): Promise<BudgetLease | null> {
    if (this.snapshot().usageUnknown) return null;
    const lease = await super.reserveComplete(maxTokens, count);
    if (this.snapshot().usageUnknown) { lease?.settle(0); return null; }
    return lease;
  }
}
const sessions = new Map<string, ShadowOutputBudget>();
export function shadowSessionOutputBudget(sessionId: string, cap: number): SessionOutputBudget {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (existing.cap !== cap) throw new Error("Session shadow output budget changed");
    existing.revive();
    return existing;
  }
  const budget = new ShadowOutputBudget(cap);
  sessions.set(sessionId, budget); return budget;
}
export function endShadowSessionBudget(sessionId: string): void { retireSessionBudget(sessions, sessionId); }
export function _shadowSessionBudgetIdsForTesting(): string[] { return [...sessions.keys()]; }
