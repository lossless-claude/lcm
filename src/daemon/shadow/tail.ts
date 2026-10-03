import { ShadowStoreError } from "./store.js";
import { safeId, type ShadowMessage } from "./types.js";

type IndexedMessage = { message: ShadowMessage; index: number };
function indexHandles(messages: readonly ShadowMessage[]): Map<string, IndexedMessage | null> {
  const handles = new Map<string, IndexedMessage | null>();
  messages.forEach((message, index) => {
    if (!safeId(message.handle)) return;
    handles.set(message.handle, handles.has(message.handle) ? null : { message, index });
  });
  return handles;
}

/** A kept tail must be an ordered subsequence of the frozen engine messages. */
export function verifyNativeTail(tail: readonly ShadowMessage[], frozen: readonly ShadowMessage[], scrub: (text: string) => string): void {
  const handles = indexHandles(frozen);
  let previous = -1;
  for (const row of tail) {
    const match = safeId(row.handle) ? handles.get(row.handle) : undefined;
    if (!match || match.index <= previous) throw new ShadowStoreError("Native tail handles conflict with the frozen messages");
    if (row.role !== match.message.role || scrub(row.text) !== scrub(match.message.text))
      throw new ShadowStoreError("Native tail content conflicts with the frozen messages");
    previous = match.index;
  }
}
