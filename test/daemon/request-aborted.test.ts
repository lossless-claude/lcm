import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { openDaemonLog, readDaemonLog, type DaemonLogOptions } from "../../src/daemon/log.js";
import { createDaemon, type DaemonInstance, type RouteHandler } from "../../src/daemon/server.js";

const EPOCH = new Date(0);
const FINISH_FLUSH_MS = 50;

let home: string | undefined;
let daemon: DaemonInstance | undefined;
afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function start(): Promise<{ port: number; records: () => Array<Record<string, unknown>> }> {
  home = mkdtempSync(join(tmpdir(), "lcm-aborted-"));
  const options: DaemonLogOptions = {
    path: join(home, "logs", "daemon.log"), level: "info", maxSizeMB: 10, retentionDays: 7, globalPatterns: [],
    projectDirFor: (cwd) => join(home ?? "", "projects", cwd.replace(/\W/g, "_")), version: "0.0.0-test",
  };
  daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }), { log: openDaemonLog(options) });
  return { port: daemon.address().port, records: () => readDaemonLog(options.path, { since: EPOCH }) };
}

/**
 * A route that answers only once released, so its client can leave first. `closed` settles when
 * the server has seen the response close, with whether it had finished by then.
 */
function heldRoute(): { handler: RouteHandler; entered: Promise<void>; closed: Promise<boolean>; release: () => void } {
  let enter = (): void => {};
  let release = (): void => {};
  let close = (_finished: boolean): void => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const closed = new Promise<boolean>((resolve) => { close = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const handler: RouteHandler = async (_req, res) => {
    // Registered after the server's own listener, so that one has run when this settles.
    res.on("close", () => close(res.writableFinished));
    enter();
    await released;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };
  return { handler, entered, closed, release };
}

/** Sends the whole request, then drops the connection while the route is still working on it. */
async function abandon(port: number, path: string, entered: Promise<void>): Promise<void> {
  const outgoing = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } });
  outgoing.on("error", () => { /* the socket this test destroys */ });
  outgoing.end(JSON.stringify({ session_id: "s1", cwd: "/work/p" }));
  await entered;
  outgoing.destroy();
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("logs request.aborted once, without a status, for an ingest whose client left before the answer", async () => {
  const { port, records } = await start();
  const held = heldRoute();
  daemon?.registerRoute("POST", "/ingest", held.handler);
  await abandon(port, "/ingest", held.entered);
  await until(() => records().some((record) => record.event === "request.aborted"));
  held.release();
  await new Promise((resolve) => setTimeout(resolve, FINISH_FLUSH_MS));

  const aborted = records().filter((record) => record.event === "request.aborted");
  expect(aborted).toHaveLength(1);
  expect(aborted[0]).toMatchObject({ level: "info", route: "POST /ingest", session_id: "s1", cwd: "/work/p" });
  expect(aborted[0].ms).toEqual(expect.any(Number));
  expect(aborted[0]).not.toHaveProperty("status");
  // Nothing reads as a landed ingest: the answer written after the client left never finishes.
  expect(records().filter((record) => record.event === "request" && record.route === "POST /ingest")).toEqual([]);
});

it("does not log request.aborted for another route whose client leaves early", async () => {
  const { port, records } = await start();
  const held = heldRoute();
  daemon?.registerRoute("POST", "/slow", held.handler);
  await abandon(port, "/slow", held.entered);
  // Released only after the server saw the client go, unfinished: the case an ingest is logged for.
  expect(await held.closed).toBe(false);
  held.release();
  await new Promise((resolve) => setTimeout(resolve, FINISH_FLUSH_MS * 4));
  expect(records().filter((record) => record.event === "request.aborted")).toEqual([]);
});

it("keeps the request record of an ingest that was answered, with no request.aborted", async () => {
  const { port, records } = await start();
  daemon?.registerRoute("POST", "/ingest", async (_req, res) => { res.writeHead(200); res.end("{}"); });
  const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: "POST", body: JSON.stringify({ session_id: "s2", cwd: "/work/q" }),
  });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, FINISH_FLUSH_MS));
  expect(records().filter((record) => record.route === "POST /ingest").map((record) => [record.event, record.status]))
    .toEqual([["request", 200]]);
});
