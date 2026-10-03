export type BudgetLease = { maxTokens?: number; allowance: number; settle(outputTokens: number | null, usageUnknown?: boolean): void };
export class SessionOutputBudget {
  private spent = 0;
  private reserved = 0;
  private unbounded = false;
  private usageUnknown = false;
  private waiters: (() => void)[] = [];
  /** Reservations still awaiting this budget; one of them may take a lease the moment it wakes. */
  private pending = 0;
  private release?: () => void;
  constructor(readonly cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("Invalid session output budget");
  }
  async reserveComplete(maxTokens: number, count = 1): Promise<BudgetLease | null> {
    positiveInteger(maxTokens); positiveInteger(count);
    return this.awaiting(async () => {
      while (this.unbounded) await this.changed();
      const allowance = Math.min(maxTokens, Math.floor(this.snapshot().available / count));
      if (!allowance) return null;
      this.reserved += allowance * count;
      return this.lease(allowance * count, allowance);
    });
  }
  /** A cut-time fork must start now or produce an unavailable outcome. */
  reserveFork(): BudgetLease | null {
    if (this.unbounded || this.reserved || !this.snapshot().available) return null;
    this.unbounded = true;
    return this.lease(this.snapshot().available);
  }
  /** Ordinary condensed jobs may wait for a preceding bounded request. */
  async reserveExclusive(): Promise<BudgetLease | null> {
    return this.awaiting(async () => {
      while (this.unbounded || this.reserved) await this.changed();
      return this.reserveFork();
    });
  }
  async reserveOrdinary(maxTokens: number, fork: boolean): Promise<BudgetLease | null> {
    return this.awaiting(async () => {
      while (this.unbounded || this.reserved) await this.changed();
      return fork ? this.reserveFork() : this.reserveComplete(maxTokens);
    });
  }
  /**
   * The session ended: `release` runs once, as soon as no lease or waiting reservation is
   * outstanding. Whoever still holds this object keeps using it; only the registry forgets it.
   */
  retire(release: () => void): void { this.release = release; this.releaseWhenIdle(); }
  /** The id is in use again, so the pending release no longer applies. */
  revive(): void { this.release = undefined; }
  private async awaiting<T>(reserve: () => Promise<T>): Promise<T> {
    this.pending++;
    try { return await reserve(); }
    finally { this.pending--; this.releaseWhenIdle(); }
  }
  private releaseWhenIdle(): void {
    const idle = !this.reserved && !this.unbounded && !this.pending;
    if (!this.release || !idle) return;
    const release = this.release; this.release = undefined; release();
  }
  snapshot() {
    return { spent: this.spent, reserved: this.reserved, unbounded: this.unbounded, usageUnknown: this.usageUnknown,
      available: Math.max(0, this.cap - this.spent - this.reserved), overshoot: Math.max(0, this.spent - this.cap) };
  }
  private changed(): Promise<void> { return new Promise(resolve => this.waiters.push(resolve)); }
  private lease(allowance: number, maxTokens?: number): BudgetLease {
    let settled = false;
    return { allowance, ...(maxTokens !== undefined ? { maxTokens } : {}), settle: (output, usageUnknown = false) => {
      if (settled) throw new Error("Budget reservation already settled");
      settled = true;
      const reported = validOutputUsage(output) ? output : null;
      this.finish({ allowance, maxTokens }, { output: reported, usageUnknown: usageUnknown || reported === null });
    } };
  }
  private finish({ allowance, maxTokens }: { allowance: number; maxTokens?: number }, { output, usageUnknown }: { output: number | null; usageUnknown: boolean }): void {
    if (maxTokens === undefined) this.unbounded = false;
    else this.reserved -= allowance;
    const unknown = usageUnknown || output === null;
    this.usageUnknown ||= unknown;
    this.spent += unknown ? Math.max(allowance, output ?? 0) : output!;
    const waiters = this.waiters; this.waiters = [];
    waiters.forEach(resolve => resolve());
    this.releaseWhenIdle();
  }
}
function validOutputUsage(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    prior.revive();
    return prior;
  }
  const budget = new SessionOutputBudget(cap);
  sessions.set(sessionId, budget); owners.set(owner, sessions);
  return budget;
}
/** Forget a session's budget once nothing is still spending against it. */
export function retireSessionBudget(sessions: Map<string, SessionOutputBudget>, sessionId: string): void {
  sessions.get(sessionId)?.retire(() => sessions.delete(sessionId));
}
export function endSharedSessionBudget(sessionId: string): void {
  const sessions = owners.get(moduleOwner);
  if (sessions) retireSessionBudget(sessions, sessionId);
}
export function _sharedSessionBudgetIdsForTesting(): string[] {
  return [...owners.get(moduleOwner)?.keys() ?? []];
}
function positiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid output reservation");
}
