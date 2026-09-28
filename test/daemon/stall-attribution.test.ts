// test/daemon/stall-attribution.test.ts
import { describe, it, expect } from "vitest";
import { beginBackgroundTask, reportStall, type InFlightRequest } from "../../src/daemon/server.js";
import type { DaemonLog, LogLevel } from "../../src/daemon/log.js";

/** Captures every `write` call instead of touching disk. */
function fakeLog(): { log: DaemonLog; records: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }> } {
  const records: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }> = [];
  return {
    records,
    log: {
      write: (level, event, fields) => { records.push({ level, event, fields }); },
      prepare: async () => {},
      state: () => ({ failing: false, dropped: 0 }),
      start: () => {},
      close: () => {},
    },
  };
}

describe("reportStall background task attribution", () => {
  it("omits work that ended before the block could begin, even between the last tick and the block", () => {
    const { log, records } = fakeLog();
    const running = { route: "POST /ingest", started: 1_500 };
    const inFlight = new Set<InFlightRequest>([
      { route: "POST /compact", started: 100, ended: 900 },
      // Closed after the last tick (1_000) but before the next one was due (2_000): the block had not begun.
      { route: "POST /restore", started: 200, ended: 1_600 },
      running,
      // Its response closed once the block ended: it ran during it.
      { route: "session-end:ingest", started: 500, ended: 7_000 },
    ]);
    reportStall(log, inFlight, { ms: 6_000, begunBy: 2_000, endedAfter: 6_000 });
    expect(records.map((r) => r.fields?.route)).toEqual(["POST /ingest", "session-end:ingest"]);
    expect([...inFlight]).toEqual([running]);
  });

  it("omits a task started after the block but before the reporting tick", () => {
    const { log, records } = fakeLog();
    const inFlight = new Set<InFlightRequest>([
      { route: "POST /ingest", started: 1_000, ended: 6_850 },
      { route: "ingest:backfill", started: 6_850 },
    ]);

    reportStall(log, inFlight, { ms: 6_000, begunBy: 2_000, endedAfter: 6_000 });

    expect(records.map((r) => r.fields?.route)).toEqual(["POST /ingest"]);
  });

  it("names a background task registered via beginBackgroundTask as the cause of a stall during it", () => {
    const { log, records } = fakeLog();
    const inFlight = new Set<InFlightRequest>();
    const endTask = beginBackgroundTask(inFlight, "scan:transcripts");

    reportStall(log, inFlight, { ms: 6_000, begunBy: Date.now() - 1, endedAfter: Date.now() + 1 });

    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toMatchObject({ ms: 6_000, route: "scan:transcripts" });

    endTask();
  });

  it("stops naming a background task once it has ended", () => {
    const { log, records } = fakeLog();
    const inFlight = new Set<InFlightRequest>();
    const endTask = beginBackgroundTask(inFlight, "scan:transcripts");
    endTask();
    // A tick with no stall clears finished tasks from the set, exactly as it does for requests.
    reportStall(log, inFlight, undefined);

    reportStall(log, inFlight, { ms: 6_000, begunBy: Date.now() + 1, endedAfter: Date.now() + 2 });

    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toEqual({ ms: 6_000 });
  });

  it("does not log a long-poll route as the cause of a stall", () => {
    const { log, records } = fakeLog();
    const inFlight = new Set<InFlightRequest>();
    inFlight.add({ route: "GET /summarize-jobs/next", started: Date.now() - 100 });
    inFlight.add({ route: "GET /summarize-jobs/next", started: Date.now() - 50 });
    inFlight.add({ route: "GET /summarize-jobs/next", started: Date.now() - 10 });

    reportStall(log, inFlight, { ms: 6_000, begunBy: Date.now() - 1, endedAfter: Date.now() + 1 });

    // One record, not one per long poll, and never blamed by route.
    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toEqual({ ms: 6_000, longPollCount: 3 });
  });

  it("still names a real cause even while long polls are in flight, without repeating the long-poll count on it", () => {
    const { log, records } = fakeLog();
    const inFlight = new Set<InFlightRequest>();
    inFlight.add({ route: "GET /summarize-jobs/next", started: Date.now() - 100 });
    inFlight.add({ route: "POST /compact", cwd: "/proj", started: Date.now() - 10 });

    reportStall(log, inFlight, { ms: 6_000, begunBy: Date.now() - 1, endedAfter: Date.now() + 1 });

    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toMatchObject({ ms: 6_000, route: "POST /compact", cwd: "/proj" });
    expect(records[0]!.fields).not.toHaveProperty("longPollCount");
  });
});
