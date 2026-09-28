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
  if (storedNow === currentNow || matchesUnderRedaction(storedNow, currentNow)) return "full";
  const nul = current.indexOf("\u0000");
  if (nul === -1) return undefined;
  const prefix = normalizeMessageContent(scrub(current.slice(0, nul)));
  return storedNow === prefix || matchesUnderRedaction(storedNow, prefix) ? "cut" : undefined;
}
