/**
 * Vote records: an agent's signal that a promoted memory is still correct (`+1`) or is
 * contradicted by current evidence (`-1`). Stored through the same `lcm_store` path as any
 * other memory, tagged `signal:memory_vote`, so this module owns only the shape a vote's
 * tags must have — not persistence.
 */

export type VoteDirection = "+1" | "-1";

export const VOTE_SIGNAL_TAG = "signal:memory_vote";

/** Parses tags persisted by older versions without trusting their JSON shape. */
export function parseStoredTags(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((tag): tag is string => typeof tag === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** Returns a stored signal's sole non-empty target, never an arbitrary one. */
export function singleMemoryIdTag(tags: string[]): string | null {
  const targets = tags.filter((tag) => tag.startsWith("memory_id:"));
  if (targets.length !== 1) return null;
  const memoryId = targets[0].slice("memory_id:".length);
  return memoryId || null;
}

/** Any reserved protocol tag (`signal:memory_used`, `signal:memory_vote`, ...). */
export function isSignalTagged(tags: string[]): boolean {
  return tags.some((t) => t.startsWith("signal:"));
}

export function isVoteRecord(tags: string[]): boolean {
  return tags.includes(VOTE_SIGNAL_TAG);
}

export interface ParsedVote {
  memoryId: string;
  direction: VoteDirection;
  reason: string;
}

/**
 * Validates a `signal:memory_vote` record's tags and text against the rules the store
 * enforces: exactly one target, exactly one vote value, and a reason. Returns the parsed
 * vote, or an error message naming the rule that was broken.
 */
export function parseVote(tags: string[], text: string): ParsedVote | { error: string } {
  const memoryIdTags = tags.filter((t) => t.startsWith("memory_id:"));
  if (memoryIdTags.length !== 1) {
    return { error: `a vote must carry exactly one memory_id:<uuid> tag (found ${memoryIdTags.length})` };
  }
  const memoryId = memoryIdTags[0].slice("memory_id:".length);
  if (!memoryId) {
    return { error: "a vote's memory_id tag must name a memory id" };
  }

  const voteTags = tags.filter((t) => t.startsWith("vote:"));
  if (voteTags.length !== 1) {
    return { error: `a vote must carry exactly one vote:+1 or vote:-1 tag (found ${voteTags.length})` };
  }
  const direction = voteTags[0].slice("vote:".length);
  if (direction !== "+1" && direction !== "-1") {
    return { error: `a vote's value must be "+1" or "-1", got "${direction}"` };
  }

  const reason = (text ?? "").trim();
  if (!reason) {
    return {
      error: direction === "+1"
        ? "a +1 vote requires a reason in the text naming the evidence that confirmed the memory"
        : "a -1 vote requires a reason in the text naming what contradicts the memory",
    };
  }

  return { memoryId, direction, reason };
}

/** Extracts the vote direction and target from an already-validated vote's tags. */
export function voteTagsOf(tags: string[]): { memoryId: string; direction: VoteDirection } | null {
  const memoryIdTag = tags.find((t) => t.startsWith("memory_id:"));
  const voteTag = tags.find((t) => t.startsWith("vote:"));
  if (!memoryIdTag || !voteTag) return null;
  const direction = voteTag.slice("vote:".length);
  if (direction !== "+1" && direction !== "-1") return null;
  return { memoryId: memoryIdTag.slice("memory_id:".length), direction };
}
