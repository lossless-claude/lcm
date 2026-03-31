export type MemoryHintCandidate = {
  id: string;
  hint: string;
};

export type MemoryHintSelection = {
  hints: string[];
  ids: string[];
  availableHintBytes: number;
  usedHintBytes: number;
  dedupedCount: number;
  droppedForBudget: number;
};

const MEMORY_CONTEXT_INTRO = "Relevant context from previous sessions (use lcm_expand for details):";

function normalizeHint(hint: string): string {
  return hint.trim().replace(/\s+/g, " ").toLowerCase();
}

function isNearDuplicate(candidate: string, existing: string, minPrefix: number): boolean {
  if (candidate === existing) return true;
  const prefix = Math.max(1, minPrefix);
  return candidate.slice(0, prefix) === existing.slice(0, prefix);
}

function trimTrailingEllipsis(hint: string): string {
  return hint.endsWith("...") ? hint.slice(0, -3).trimEnd() : hint;
}

function fitHintWithinBudget(
  selected: MemoryHintCandidate[],
  candidate: MemoryHintCandidate,
  availableHintBytes: number,
): string | null {
  const fullBlock = buildMemoryContext(
    [...selected.map((entry) => entry.hint), candidate.hint],
    [...selected.map((entry) => entry.id), candidate.id],
  );
  if (fullBlock && Buffer.byteLength(fullBlock, "utf8") <= availableHintBytes) {
    return candidate.hint;
  }

  const baseHint = trimTrailingEllipsis(candidate.hint);

  // Binary search for the longest prefix that fits within the budget.
  // Buffer.byteLength is monotonically non-decreasing as prefix length grows
  // (each additional UTF-8 character adds ≥ 1 byte), so binary search is valid.
  let lo = 0;
  let hi = baseHint.length - 1;
  let bestFit: string | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const truncated = `${baseHint.slice(0, mid + 1).trimEnd()}...`;
    const block = buildMemoryContext(
      [...selected.map((entry) => entry.hint), truncated],
      [...selected.map((entry) => entry.id), candidate.id],
    );
    if (block && Buffer.byteLength(block, "utf8") <= availableHintBytes) {
      bestFit = truncated;
      lo = mid + 1; // try a longer prefix
    } else {
      hi = mid - 1; // try a shorter prefix
    }
  }

  return bestFit;
}

export function buildMemoryContext(hints: string[], ids: string[] = []): string | null {
  if (hints.length === 0) return null;
  const snippets = hints.map((hint) => `- ${hint}`).join("\n");
  const idsComment = ids.length > 0
    ? `\n<!-- surfaced-memory-ids: ${ids.join(",")} -->`
    : "";
  return `<memory-context>\n${MEMORY_CONTEXT_INTRO}\n${snippets}${idsComment}\n</memory-context>`;
}

export function selectMemoryHintsWithinBudget(
  candidates: MemoryHintCandidate[],
  options: {
    totalByteBudget: number;
    reservedForLearningInstruction: number;
    learningInstructionBytes: number;
    maxEmitted: number;
    dedupMinPrefix: number;
  },
): MemoryHintSelection {
  const reserve = Math.max(
    0,
    Math.floor(options.reservedForLearningInstruction),
    Math.floor(options.learningInstructionBytes),
  );
  const availableHintBytes = Math.max(0, Math.floor(options.totalByteBudget) - reserve);
  const maxEmitted = Math.max(0, Math.floor(options.maxEmitted));

  const deduped: MemoryHintCandidate[] = [];
  const seen: string[] = [];
  let dedupedCount = 0;

  for (const candidate of candidates) {
    const trimmedHint = candidate.hint.trim();
    if (!trimmedHint) continue;

    const normalized = normalizeHint(trimmedHint);
    if (seen.some((existing) => isNearDuplicate(normalized, existing, options.dedupMinPrefix))) {
      dedupedCount += 1;
      continue;
    }

    seen.push(normalized);
    deduped.push({ id: candidate.id, hint: trimmedHint });
  }

  const emitted: MemoryHintCandidate[] = [];
  let droppedForBudget = 0;

  for (const candidate of deduped) {
    if (emitted.length >= maxEmitted) {
      droppedForBudget += 1;
      continue;
    }

    const fittedHint = fitHintWithinBudget(emitted, candidate, availableHintBytes);
    if (!fittedHint) {
      droppedForBudget += 1;
      continue;
    }

    emitted.push({ id: candidate.id, hint: fittedHint });
  }

  const hints = emitted.map((candidate) => candidate.hint);
  const ids = emitted.map((candidate) => candidate.id);
  const block = buildMemoryContext(hints, ids);
  const usedHintBytes = block ? Buffer.byteLength(block, "utf8") : 0;

  return {
    hints,
    ids,
    availableHintBytes,
    usedHintBytes,
    dedupedCount,
    droppedForBudget,
  };
}