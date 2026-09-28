import { matchesUnderRedaction } from "./scrub.js";

/** SQLite TEXT reads stop at NUL; U+FFFD preserves the visible boundary and the text after it. */
export function normalizeMessageContent(text: string): string {
  return text.replaceAll("\u0000", "\uFFFD");
}

/** A cut match identifies a row written before NUL normalization and eligible for rebuilding. */
export function compareStoredMessageContent(
  stored: string, current: string, scrub: (text: string) => string,
): "full" | "cut" | undefined {
  // Scrubbing is the expensive part; identical text needs none.
  if (stored === current || stored === normalizeMessageContent(current)) return "full";
  const storedNow = normalizeMessageContent(scrub(stored));
  const currentNow = normalizeMessageContent(scrub(current));
  if (storedNow === currentNow) return "full";
  // A cut row is checked before the redaction allowance: a redaction marker can absorb the
  // text after the NUL, which would pass a cut row off as whole and leave it unrepaired.
  const nul = current.indexOf("\u0000");
  if (nul !== -1) {
    const prefix = normalizeMessageContent(scrub(current.slice(0, nul)));
    if (storedNow === prefix || matchesUnderRedaction(storedNow, prefix)) return "cut";
  }
  return matchesUnderRedaction(storedNow, currentNow) ? "full" : undefined;
}
