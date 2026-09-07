/**
 * Parse a timestamp column written by SQLite's `datetime('now')`.
 *
 * `datetime('now')` yields UTC as `YYYY-MM-DD HH:MM:SS` with no timezone marker,
 * and `new Date(...)` reads a marker-less string as LOCAL time. Every row would
 * therefore be off by the reader's UTC offset — invisible in CI (UTC), but in
 * UTC+2 a summary written a second ago looks two hours old, and west of UTC a
 * stale row looks fresh. Comparisons against `Date.now()` are the ones that break.
 *
 * Values already carrying a marker (ISO strings ending in `Z` or `±HH:MM`) are
 * passed through unchanged.
 */
export function parseSqliteDate(value: string): Date {
  return new Date(hasTimezoneMarker(value) ? value : `${value.replace(" ", "T")}Z`);
}

function hasTimezoneMarker(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
}
