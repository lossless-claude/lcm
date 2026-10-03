export type ShadowAppend = { sessionId: string; epoch: number; order: number; door: string };

/** Pending or denied appends never replace the last stored model-visible row. */
export class ShadowBoundaries {
  private order = 0;
  private stored = new Map<string, { uuid: string; order: number }>();
  begin(sessionId: string, epoch: number, door: string): ShadowAppend { return { sessionId, epoch, order: ++this.order, door }; }
  complete(owner: ShadowAppend, uuid: string): void {
    if (owner.order > (this.stored.get(owner.sessionId)?.order ?? 0)) this.stored.set(owner.sessionId, { uuid, order: owner.order });
  }
  boundary(sessionId: string): string | undefined { return this.stored.get(sessionId)?.uuid; }
  entries(): [string, string][] { return [...this.stored].map(([sessionId, row]) => [sessionId, row.uuid]); }
  reset(sessionId: string): void { this.stored.delete(sessionId); }
}
