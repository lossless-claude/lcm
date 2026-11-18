import { matchesUnderRedaction, REDACTION_MARKER } from "./scrub.js";

/** SQLite TEXT reads stop at NUL; U+FFFD preserves the visible boundary and the text after it. */
export function normalizeMessageContent(text: string): string {
  return text.replaceAll("\u0000", "�");
}

/**
 * The placeholder tokenade's cold-resume compaction writes over a stale tool output in the
 * transcript itself (`session_compact.rs`, `placeholder_for`): alone, or after a kept opening
 * as `{head}\n{placeholder}`. Either way it ends the value it folds: a tool output part, or a
 * string in a tool input. In a row joining several values it starts the text or a line and
 * ends the text or a line.
 */
const TOKENADE_PLACEHOLDER = String.raw`\[tokenade:elided (\d+) tokens on cold resume — recover: (?:tokenade expand-ref ([0-9a-f]+)|\(original not stashed\))\]`;
const TOKENADE_FOLDS = new RegExp(String.raw`(?<=^|\n)${TOKENADE_PLACEHOLDER}(?=\n|$)`, "g");
const TOKENADE_FOLDED_VALUE = new RegExp(String.raw`(?:^|\n)${TOKENADE_PLACEHOLDER}$`);
// How much of a folded span's minimum one redaction may stand for: a secret of 8192 characters,
// more than an 8192-bit private key holds, at the densest 1.3 characters a token.
const REDACTED_SECRET_SPAN = Math.ceil(8192 / 1.3 / 4);

/** Did tokenade fold this tool output part or input value? Text after a placeholder is a quote. */
export function isTokenadeFold(value: string): boolean {
  return value.includes("[tokenade:elided ") && TOKENADE_FOLDED_VALUE.test(value);
}

/**
 * A cut match identifies a row written before NUL normalization and eligible for rebuilding.
 * An elided match is a stored row whose transcript copy tokenade has since folded: the
 * transcript no longer holds the original, so the stored row can be appended after but never
 * rebuilt from. Only a row the parser found `elided` is tried, so a placeholder another row
 * merely quotes, or one in a harness tokenade does not rewrite, never stands for stored text.
 */
export function compareStoredMessageContent(
  stored: string, current: string, scrub: (text: string) => string, elided = false,
): "full" | "cut" | "elided" | undefined {
  // Scrubbing is the expensive part; identical text needs none.
  if (stored === current || stored === normalizeMessageContent(current)) return "full";
  const storedNow = normalizeMessageContent(scrub(stored));
  const currentNow = normalizeMessageContent(scrub(current));
  if (storedNow === currentNow) return "full";
  const fold = elided ? current.search(TOKENADE_FOLDS) : -1;
  // A cut row is checked before the redaction allowance: a redaction marker can absorb the
  // text after the NUL, which would pass a cut row off as whole and leave it unrepaired. Text
  // cut before the first placeholder holds none for a marker to stand for.
  const nul = current.indexOf("\u0000");
  if (nul !== -1 && (fold === -1 || nul < fold)) {
    const prefix = normalizeMessageContent(scrub(current.slice(0, nul)));
    if (storedNow === prefix || matchesUnderRedaction(storedNow, prefix)) return "cut";
  }
  // Only the elision match may account for a placeholder, with each hidden span's minimum; the
  // redaction allowance below would let one stored marker stand for a span of any size.
  if (fold !== -1) {
    if (matchesUnderElision(storedNow, current, scrub)) return "elided";
    return matchesAroundHeldFolds(stored, current, scrub) ? "full" : undefined;
  }
  return matchesUnderRedaction(storedNow, currentNow) ? "full" : undefined;
}

/**
 * A character `current` does not hold, to stand in for each placeholder while text is scrubbed.
 * One a stored row still holds after scrubbing is literal text `current` lacks, so it fails either way.
 */
function standInFor(current: string): string {
  let code = 0xe000;
  while (current.includes(String.fromCharCode(code))) code++;
  return String.fromCharCode(code);
}

/**
 * True when `stored` was captured holding `current`'s placeholders, in the same order, so they
 * hid nothing from it: the text around them is compared under the redaction allowance, which
 * cannot carry a marker across a placeholder.
 */
function matchesAroundHeldFolds(stored: string, current: string, scrub: (text: string) => string): boolean {
  const folds = current.match(TOKENADE_FOLDS) ?? [];
  const held = stored.match(TOKENADE_FOLDS) ?? [];
  if (held.length !== folds.length || held.some((placeholder, index) => placeholder !== folds[index])) return false;
  const standIn = standInFor(current);
  const around = (text: string) => normalizeMessageContent(scrub(text.replace(TOKENADE_FOLDS, standIn))).split(standIn);
  const storedParts = around(stored);
  const currentParts = around(current);
  return storedParts.length === folds.length + 1 && currentParts.length === folds.length + 1
    && storedParts.every((part, index) => part === currentParts[index] || matchesUnderRedaction(part, currentParts[index]));
}

/**
 * True when `current` is `stored` with spans folded by tokenade: the text around each
 * placeholder appears in `stored` in order, anchored at both ends, and each folded span is long
 * enough for what its placeholder reports hiding. Both sides are compared under the current
 * redaction rules; a span redacted on one side and literal on the other is not absorbed.
 */
export function matchesUnderElision(storedNow: string, current: string, scrub: (text: string) => string): boolean {
  const folds = [...current.matchAll(TOKENADE_FOLDS)];
  if (folds.length === 0) return false;
  // Stands in for each placeholder while the text is scrubbed, so no pattern can rewrite one.
  const standIn = standInFor(current);
  const segments = normalizeMessageContent(scrub(current.replace(TOKENADE_FOLDS, standIn))).split(standIn);
  // A pattern that swallowed a stand-in leaves nothing to anchor that span by.
  if (segments.length !== folds.length + 1) return false;
  // The newline before a placeholder is scrubbed with the line it ends, as the original has it
  // when tokenade kept whole lines; it is dropped after, as tokenade adds it itself when it cuts
  // a line short.
  const kept = segments.map((segment, index) =>
    (index < folds.length && segment.endsWith("\n") ? segment.slice(0, -1) : segment));
  // The newline after a placeholder starts the next value's line. A pattern that redacted the end
  // of the folded output may have taken it in the stored row; the marker left there ends the span.
  const last = kept[folds.length];
  const lastTaken = last.startsWith("\n") ? REDACTION_MARKER + last.slice(1) : undefined;
  const tail = storedNow.endsWith(last) ? last.length
    : lastTaken !== undefined && storedNow.endsWith(lastTaken) ? last.length - 1 : -1;
  if (tail === -1 || !storedNow.startsWith(kept[0])) return false;
  const end = storedNow.length - tail;
  // Measured on 568 real folds, a reported token hid 1.3 to 8.5 characters; a quarter leaves room
  // for dense text. A span starting at `from` that is tokenade's own large-output notice, naming
  // the placeholder's size and stash, was folded under both and needs only to hold that notice.
  const span = (from: number, [, tokens, stash]: RegExpMatchArray): number => {
    const close = storedNow.indexOf("]", from);
    const notice = stash !== undefined && close !== -1
      && storedNow.startsWith(`[tokenade: this blob is ~${tokens} tokens `, from)
      && storedNow.slice(from, close).includes(`tokenade expand-ref ${stash}`);
    return notice ? close + 1 - from : Math.max(1, Math.ceil(Number(tokens) / 4));
  };
  // Tokens count the original, so each redaction in the stored span may stand for one secret's
  // worth of what was hidden, but no more.
  const floor = (from: number, span: number) => {
    let need = from + span;
    for (let marker = storedNow.indexOf(REDACTION_MARKER, from); marker !== -1 && marker < need;
      marker = storedNow.indexOf(REDACTION_MARKER, marker + REDACTION_MARKER.length)) {
      need = Math.max(marker + REDACTION_MARKER.length, need - REDACTED_SECRET_SPAN);
    }
    return need;
  };
  // Where `segment`, the text after a fold, ends in the stored row when the span before it ends
  // at `from` or later; -1 when it is not there.
  const place = (segment: string, at: number, from: number): number => {
    const found = storedNow.indexOf(segment, from);
    const exact = found === -1 ? Infinity : found + segment.length;
    // A marker that took the newline belongs to the span, so it may begin before `from`.
    const taken = segment.startsWith("\n") ? REDACTION_MARKER + segment.slice(1) : undefined;
    const marker = taken === undefined ? -1 : storedNow.indexOf(taken, Math.max(at, from - REDACTION_MARKER.length));
    const placed = Math.min(exact, marker === -1 || taken === undefined ? Infinity : marker + taken.length);
    return placed === Infinity ? -1 : placed;
  };
  // Leftmost placement is exact when every span has only a minimum length.
  let at = kept[0].length;
  for (let index = 1; index < folds.length; index++) {
    at = place(kept[index], at, floor(at, span(at, folds[index - 1])));
    if (at === -1) return false;
  }
  return end >= floor(at, span(at, folds[folds.length - 1]));
}
