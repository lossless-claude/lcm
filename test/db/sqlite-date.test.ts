import { describe, it, expect } from "vitest";
import { parseSqliteDate } from "../../src/db/sqlite-date.js";

describe("parseSqliteDate", () => {
  it("reads a marker-less datetime('now') value as UTC, not local time", () => {
    expect(parseSqliteDate("2026-09-07 20:33:48").toISOString()).toBe("2026-09-07T20:33:48.000Z");
  });

  it("is stable regardless of the reader's timezone", () => {
    // new Date("2026-09-07 20:33:48") would shift by the local UTC offset.
    const parsed = parseSqliteDate("2026-09-07 20:33:48").getTime();
    expect(parsed).toBe(Date.UTC(2026, 8, 7, 20, 33, 48));
  });

  it("passes through a value that already carries a timezone marker", () => {
    expect(parseSqliteDate("2026-09-07T20:33:48Z").toISOString()).toBe("2026-09-07T20:33:48.000Z");
    expect(parseSqliteDate("2026-09-07T22:33:48+02:00").toISOString()).toBe("2026-09-07T20:33:48.000Z");
  });

  it("round-trips a value written now within a second", () => {
    const now = new Date();
    const sqliteShaped = now.toISOString().slice(0, 19).replace("T", " ");
    expect(Math.abs(parseSqliteDate(sqliteShaped).getTime() - now.getTime())).toBeLessThan(1000);
  });
});
