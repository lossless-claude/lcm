export type BudgetLease = { maxTokens?: number; allowance: number; settle(outputTokens: number | null, usageUnknown?: boolean): void };
export class SessionOutputBudget {
  private spent = 0;
  private reserved = 0;
  private unbounded = false;
  private usageUnknown = false;
  private waiters: (() => void)[] = [];
  constructor(readonly cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("Invalid session output budget");
  }
  async reserveComplete(maxTokens: number, count = 1): Promise<BudgetLease | null> {
    positiveInteger(maxTokens); positiveInteger(count);
    while (this.unbounded) await this.changed();
    const allowance = Math.min(maxTokens, Math.floor(this.snapshot().available / count));
    if (!allowance) return null;
    this.reserved += allowance * count;
    return this.lease(allowance * count, allowance);
  }
  /** A cut-time fork must start now or produce an unavailable outcome. */
  reserveFork(): BudgetLease | null {
    if (this.unbounded || this.reserved || !this.snapshot().available) return null;
    this.unbounded = true;
    return this.lease(this.snapshot().available);
  }
  /** Ordinary condensed jobs may wait for a preceding bounded request. */
  async reserveExclusive(): Promise<BudgetLease | null> {
    while (this.unbounded || this.reserved) await this.changed();
    return this.reserveFork();
  }
  async reserveOrdinary(maxTokens: number, fork: boolean): Promise<BudgetLease | null> {
    while (this.unbounded || this.reserved) await this.changed();
    return fork ? this.reserveFork() : this.reserveComplete(maxTokens);
  }
  snapshot() {
    return { spent: this.spent, reserved: this.reserved, unbounded: this.unbounded, usageUnknown: this.usageUnknown,
      available: this.usageUnknown ? 0 : Math.max(0, this.cap - this.spent - this.reserved), overshoot: Math.max(0, this.spent - this.cap) };
  }
  private changed(): Promise<void> { return new Promise(resolve => this.waiters.push(resolve)); }
  private lease(allowance: number, maxTokens?: number): BudgetLease {
    let settled = false;
    return { allowance, ...(maxTokens !== undefined ? { maxTokens } : {}), settle: (output, usageUnknown = false) => {
      if (settled) throw new Error("Budget reservation already settled");
      if (output !== null && (!Number.isSafeInteger(output) || output < 0)) throw new Error("Invalid output usage");
      settled = true;
      this.finish({ allowance, maxTokens }, { output, usageUnknown });
    } };
  }
  private finish({ allowance, maxTokens }: { allowance: number; maxTokens?: number }, { output, usageUnknown }: { output: number | null; usageUnknown: boolean }): void {
    if (maxTokens === undefined) this.unbounded = false;
    else this.reserved -= allowance;
    this.usageUnknown ||= usageUnknown || output === null;
    if (output !== null) this.spent += output;
    const waiters = this.waiters; this.waiters = [];
    waiters.forEach(resolve => resolve());
  }
}
const owners = new WeakMap<object, Map<string, SessionOutputBudget>>();
const moduleOwner = {};
/** Dispatch facades need not have stable object identity; this owner does. */
export function sharedSessionOutputBudget(sessionId: string, cap: number): SessionOutputBudget {
  return sessionOutputBudget(moduleOwner, sessionId, cap);
}
export function sessionOutputBudget(owner: object, sessionId: string, cap: number): SessionOutputBudget {
  const sessions = owners.get(owner) ?? new Map<string, SessionOutputBudget>();
  const prior = sessions.get(sessionId);
  if (prior) {
    if (prior.cap !== cap) throw new Error("Session output budget changed");
    return prior;
  }
  const budget = new SessionOutputBudget(cap);
  sessions.set(sessionId, budget); owners.set(owner, sessions);
  return budget;
}
function positiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid output reservation");
}
