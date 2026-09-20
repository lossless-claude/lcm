import { fenceContent } from "../content-fence.js";

/**
 * Fitting a restore's blocks into a byte budget. Pure: no database, no configuration,
 * no filesystem — the arithmetic is the whole module.
 */

/** Fences `content` under `tag`, trimmed to the last code point that fits `byteBudget`. */
export function fitFencedText(content: string, tag: string, byteBudget: number): string {
  const normalized = content.trim();
  const budget = Math.max(0, Math.floor(byteBudget));
  if (!normalized || budget === 0) return "";

  const full = fenceContent(normalized, tag);
  if (Buffer.byteLength(full, "utf8") <= budget) return full;

  const points = Array.from(normalized);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = `${points.slice(0, middle).join("").trimEnd()}...`;
    const fenced = fenceContent(candidate, tag);
    if (Buffer.byteLength(fenced, "utf8") <= budget) {
      best = fenced;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Fences as many whole items as fit, newest last: the tail of the context is what a resume needs. */
export function fitRecentContextItems(items: string[], tag: string, byteBudget: number): string {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  const selected: string[] = [];

  for (let index = normalized.length - 1; index >= 0; index--) {
    const candidate = [normalized[index], ...selected];
    const fenced = fenceContent(candidate.join("\n\n"), tag);
    if (Buffer.byteLength(fenced, "utf8") <= byteBudget) {
      selected.unshift(normalized[index]);
      continue;
    }
    if (selected.length === 0) {
      return fitFencedText(normalized[index], tag, byteBudget);
    }
    break;
  }

  return selected.length > 0 ? fenceContent(selected.join("\n\n"), tag) : "";
}

/** What is left of `totalBudget` once the blocks already gathered are joined with the separators. */
export function remainingContextBudget(parts: string[], totalBudget: number): number {
  const used = Buffer.byteLength(parts.join("\n\n"), "utf8");
  const separator = parts.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0;
  return Math.max(0, Math.floor(totalBudget) - used - separator);
}

/** Fences the parts under one tag, or answers empty when there is nothing to fence. */
export function fenceOrEmpty(parts: string[], tag: string): string {
  return parts.length > 0 ? fenceContent(parts.join("\n\n"), tag) : "";
}

