import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
import { Buffer } from "node:buffer";

/**
 * Default timeout for short-lived daemon calls (health checks, GETs).
 *
 * `post()` has NO default timeout: `/compact` is a synchronous long job that
 * sends no response headers until the whole conversation finishes, so a fixed
 * timeout reports spurious failures at exactly the timeout boundary while the
 * daemon carries on and completes the work (issue #275). Previously the global
 * `fetch` applied undici's default 300s `headersTimeout`, which made every
 * conversation needing >5 min report `FAILED (fetch failed)` despite
 * succeeding server-side.
 */
const GET_REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

export type RequestOptions = {
  /** Request timeout in ms. Pass 0 to disable. POSTs default to 0 (no timeout). */
  timeoutMs?: number;
  /** Optional caller-controlled cancellation. */
  signal?: AbortSignal;
};

/**
 * Client for the lcm daemon's HTTP API.
 *
 * Uses node:http directly instead of fetch so that long-running POSTs
 * (/compact) are not killed by undici's default 300s headersTimeout. The
 * daemon completes the work regardless — the client just needs to be able to
 * wait for it.
 */
export class DaemonClient {
  private token: string | null = null;
  private tokenLoaded = false;

  constructor(private baseUrl: string, private tokenPath?: string) {}

  private getToken(): string | null {
    if (!this.tokenLoaded) {
      this.token = readAuthToken(
        this.tokenPath ?? join(homedir(), ".lossless-claude", "daemon.token"),
      );
      this.tokenLoaded = true;
    }
    return this.token;
  }

  /**
   * Perform an HTTP request against the daemon and return the parsed JSON body.
   *
   * Error contract (stable — MCP auto-restart and batch-compact rely on it):
   * - Non-2xx: throw Error with `.status` (HTTP code) and `.body` (parsed JSON).
   * - Network/socket failure (ECONNREFUSED, ECONNRESET, timeout, abort): throw
   *   a TypeError so `isNetworkError()` in mcp/server.ts treats it as a
   *   connection problem and triggers daemon auto-restart. Timeout/abort errors
   *   additionally keep `.name = "TimeoutError"`/`"AbortError"` so callers can
   *   distinguish "client gave up" from a real daemon failure.
   */
  private rawRequest<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    opts: RequestOptions,
  ): Promise<T> {
    const token = this.getToken();
    const url = new URL(`${this.baseUrl}${path}`);
    const json = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(json));
    }

    const timeoutMs = opts.timeoutMs !== undefined
      ? opts.timeoutMs
      : (method === "GET" ? GET_REQUEST_TIMEOUT_MS : 0);

    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", (err) => {
            const e = err instanceof Error ? err : new Error(String(err));
            fail(e);
          });
          res.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
          res.on("end", () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch (parseErr) {
              if (status >= 200 && status < 300) {
                // A 2xx with unparseable JSON is a daemon/proxy bug, not a
                // valid success payload -- reject rather than silently
                // resolving a fake `{ error }` object mistyped as T.
                settled = true;
                const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
                reject(new Error(`Invalid JSON in response body (status ${status}): ${message}`));
                return;
              }
              // Non-2xx responses legitimately may carry a non-JSON error
              // body (plain text, HTML error page, etc.) -- fall back to an
              // error envelope built from the raw text.
              parsed = { error: text || res.statusMessage };
            }
            settled = true;
            if (status < 200 || status >= 300) {
              const errBody = (parsed ?? {}) as Record<string, unknown>;
              const e = new Error(
                typeof errBody.error === "string" ? errBody.error : "HTTP " + status,
              ) as Error & { status?: number; body?: Record<string, unknown> };
              e.status = status;
              e.body = errBody;
              reject(e);
              return;
            }
            resolve(parsed as T);
          });
        },
      );

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        // Normalize all network/timeout/abort failures to TypeError so MCP's
        // isNetworkError() auto-restart logic keeps working.
        const normalized = new TypeError(err.message) as TypeError & { cause?: unknown };
        normalized.name = err.name; // preserve TimeoutError / AbortError
        normalized.cause = err;
        req.destroy();
        reject(normalized);
      };

      req.on("error", (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        fail(e);
      });

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          const err = new Error("Request timed out after " + timeoutMs + "ms");
          err.name = "TimeoutError";
          fail(err);
        });
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          fail(err);
          return;
        }
        opts.signal.addEventListener("abort", () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          fail(err);
        }, { once: true });
      }

      if (json !== undefined) req.write(json);
      req.end();
    });
  }

  async health(): Promise<{ status: string; uptime: number } | null> {
    try {
      const res = await this.rawRequest<{ status: string; uptime: number }>(
        "GET", "/health", undefined, { timeoutMs: HEALTH_TIMEOUT_MS },
      );
      return res.status === "ok" ? res : null;
    } catch { return null; }
  }

  async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.rawRequest<T>("GET", path, undefined, opts);
  }

  async post<T = unknown>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.rawRequest<T>("POST", path, body, opts);
  }
}
