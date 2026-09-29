/**
 * The SDKs' own per-request default, so a hosted endpoint behaves as before. A slow local
 * model can take minutes over one summary; an endpoint that should fail over sooner sets
 * `timeoutMs`. With no SDK retries and none after a timeout, a silent endpoint costs this once.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 600_000;

export function isRequestTimeout(error: unknown): boolean {
  return (error as Error)?.name === "APIConnectionTimeoutError";
}

/** Bound one attempt even when an SDK or HTTP transport does not honor its timeout promptly. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(controller.signal),
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
