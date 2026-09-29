/**
 * The SDKs' own per-request default, so a hosted endpoint behaves as before. A slow local
 * model can take minutes over one summary; an endpoint that should fail over sooner sets
 * `timeoutMs`. With no SDK retries and none after a timeout, a silent endpoint costs this once.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 600_000;

/** lcm's deadline, or the SDK's own timer when it fires first: the SDKs do not set `name`. */
export function isRequestTimeout(error: unknown): boolean {
  const failure = error as Error | undefined;
  return failure?.name === "APIConnectionTimeoutError" || failure?.constructor?.name === "APIConnectionTimeoutError";
}

/**
 * Bound one attempt even when an SDK or HTTP transport does not honor its timeout promptly.
 * The request passes `timeout` to its SDK, whose own 10-minute default would cut a longer deadline.
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  request: (options: { signal: AbortSignal; timeout: number }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request({ signal: controller.signal, timeout: timeoutMs }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`request timed out after ${timeoutMs}ms`);
          error.name = "APIConnectionTimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
