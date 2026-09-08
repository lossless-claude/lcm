import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummarizeJobStore } from "../../../src/daemon/summarize-jobs.js";
import { createNextSummarizeJobHandler, createAnswerSummarizeJobHandler } from "../../../src/daemon/routes/summarize-jobs.js";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { ensureAuthToken, readAuthToken } from "../../../src/daemon/auth.js";

const input = { session_id: "one", kind: "leaf" as const, depth: 0, system: "system", prompt: "prompt", targetTokens: 1000, maxTokens: 2000 };
function response() {
  return Object.assign(new EventEmitter(), { destroyed: false, writeHead: vi.fn(), end: vi.fn() });
}
function request(url: string) { return { url } as IncomingMessage; }

describe("summarize job routes", () => {
  let store: SummarizeJobStore;
  beforeEach(() => { vi.useFakeTimers(); store = new SummarizeJobStore(); });
  afterEach(() => { store.close(); vi.useRealTimers(); });

  it("holds an empty poll for 25 seconds, then answers 204", async () => {
    const res = response();
    const pending = createNextSummarizeJobHandler(store)(request("/summarize-jobs/next?session_id=one"), res as unknown as ServerResponse, "");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(res.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(res.writeHead).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("delivers a job once without internal state, replacing a previous waiter", async () => {
    const handler = createNextSummarizeJobHandler(store);
    const first = response();
    const second = response();
    const req = request("/summarize-jobs/next?session_id=one");
    const oldPoll = handler(req, first as unknown as ServerResponse, "");
    const currentPoll = handler(req, second as unknown as ServerResponse, "");
    await oldPoll;
    expect(first.writeHead).toHaveBeenCalledWith(204);
    void store.enqueue(input);
    await currentPoll;
    expect(second.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const { job } = JSON.parse(second.end.mock.calls[0]![0]);
    expect(job).toMatchObject(input);
    expect(job).not.toHaveProperty("state");
    expect(job).not.toHaveProperty("resolve");
    const third = response();
    const nextPoll = handler(req, third as unknown as ServerResponse, "");
    await vi.advanceTimersByTimeAsync(25_000);
    await nextPoll;
    expect(third.writeHead).toHaveBeenCalledWith(204);
  });

  it("never delivers another session's job", async () => {
    void store.enqueue(input);
    const res = response();
    const pending = createNextSummarizeJobHandler(store)(request("/summarize-jobs/next?session_id=other"), res as unknown as ServerResponse, "");
    const matching = await store.next("one");
    expect(matching?.session_id).toBe("one");
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });

  it.each(["/summarize-jobs/next", "/summarize-jobs/next?session_id=%20"])("rejects a missing session id: %s", async (url) => {
    const res = response();
    await createNextSummarizeJobHandler(store)(request(url), res as unknown as ServerResponse, "");
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  });

  it.each(["not JSON", "null", "[]", "{}", '{"text":" "}', '{"text":5}', '{"text":"ok","error":"bad"}',
    '{"text":"ok","providerId":"openai"}', '{"text":"ok","usage":{"input_tokens":-1,"output_tokens":1,"estimated":true}}',
    '{"text":"ok","usage":{"input_tokens":1,"output_tokens":1.5,"estimated":true}}',
    '{"text":"ok","usage":{"input_tokens":1,"output_tokens":1,"estimated":"true"}}'])
  ("rejects malformed answers: %s", async (body) => {
    const res = response();
    await createAnswerSummarizeJobHandler(store)(request("/summarize-jobs/id"), res as unknown as ServerResponse, body);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  });

  it("accepts trimmed text and discards duplicate and expired answers", async () => {
    const pending = store.enqueue(input);
    const job = await store.next("one");
    const handler = createAnswerSummarizeJobHandler(store);
    const accepted = response();
    await handler(request(`/summarize-jobs/${job!.id}`), accepted as unknown as ServerResponse, '{"text":" summary "}');
    await expect(pending).resolves.toMatchObject({ text: "summary" });
    expect(JSON.parse(accepted.end.mock.calls[0]![0])).toEqual({ discarded: false });
    const duplicate = response();
    await handler(request(`/summarize-jobs/${job!.id}`), duplicate as unknown as ServerResponse, '{"text":"again"}');
    expect(JSON.parse(duplicate.end.mock.calls[0]![0])).toEqual({ discarded: true });
    void store.enqueue(input);
    const expiredJob = await store.next("one");
    await vi.advanceTimersByTimeAsync(20_000);
    const late = response();
    await handler(request(`/summarize-jobs/${expiredJob!.id}`), late as unknown as ServerResponse, '{"text":"late"}');
    expect(late.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(JSON.parse(late.end.mock.calls[0]![0])).toEqual({ discarded: true });
  });

  it("accepts model errors and returns 404 for unknown jobs", async () => {
    const pending = store.enqueue(input);
    const job = await store.next("one");
    const handler = createAnswerSummarizeJobHandler(store);
    await handler(request(`/summarize-jobs/${job!.id}`), response() as unknown as ServerResponse, '{"error":"spend cap"}');
    await expect(pending).resolves.toMatchObject({ error: "spend cap" });
    const missing = response();
    await handler(request("/summarize-jobs/missing"), missing as unknown as ServerResponse, '{"text":"summary"}');
    expect(missing.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
});

describe("summarize routes server integration", () => {
  it("requires bearer auth for both routes, routes query strings, and enforces the body cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-jobs-auth-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent", { daemon: { port: 0, idleTimeoutMs: 0 } }, {});
    const daemon = await createDaemon(config, { tokenPath });
    const base = `http://127.0.0.1:${daemon.address().port}`;
    const status = async (path: string, options?: RequestInit) => {
      const res = await fetch(`${base}${path}`, { ...options, headers: { ...options?.headers, Connection: "close" } });
      await res.text();
      return res.status;
    };
    try {
      expect(await status("/summarize-jobs/next?session_id=one")).toBe(401);
      expect(await status("/summarize-jobs/id", { method: "POST", body: '{"text":"ok"}' })).toBe(401);
      const headers = { Authorization: `Bearer ${readAuthToken(tokenPath)}`, "Content-Type": "application/json" };
      expect(await status("/summarize-jobs/next?session_id=", { headers })).toBe(400);
      expect(await status("/summarize-jobs/id", { method: "POST", headers, body: '{"text":"ok"}' })).toBe(404);
      // The server answers 413 as soon as the cap is crossed and stops reading; a client still
      // writing the body may see the reset before the status. Either is the cap working.
      const capped = await status("/summarize-jobs/id", { method: "POST", headers, body: "x".repeat(11 * 1024 * 1024) })
        .catch((error: unknown) => (error as { cause?: { code?: string } })?.cause?.code ?? "reset");
      expect([413, "ECONNRESET", "EPIPE", "reset"]).toContain(capped);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
