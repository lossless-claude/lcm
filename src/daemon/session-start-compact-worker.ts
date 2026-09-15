import { isMainThread, parentPort, Worker } from "node:worker_threads";
import type { UncompactedConversation } from "../batch-compact.js";
import type { LcmPaths } from "../lcm-paths.js";

type ScanRequest = {
  id: number;
  paths: LcmPaths;
  minTokens: number;
  cwd: string;
};

type ScanResponse =
  | { id: number; candidates: UncompactedConversation[] }
  | { id: number; error: string };

export type SessionStartCompactScanner = {
  scan(paths: LcmPaths, minTokens: number, cwd: string): Promise<UncompactedConversation[]>;
};

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

if (!isMainThread) {
  const port = parentPort;
  if (!port) {
    throw new Error("SessionStart compact worker has no parent port");
  }

  let findUncompacted: typeof import("../batch-compact.js").findUncompacted | undefined;
  port.on("message", async (request: ScanRequest) => {
    try {
      const scan = findUncompacted ?? (await import("../batch-compact.js")).findUncompacted;
      findUncompacted = scan;
      port.postMessage({
        id: request.id,
        candidates: scan(request.paths, request.minTokens, false, request.cwd),
      } satisfies ScanResponse);
    } catch (error) {
      port.postMessage({ id: request.id, error: toError(error).message } satisfies ScanResponse);
    }
  });
}

export function createSessionStartCompactScanner(): SessionStartCompactScanner {
  let nextId = 0;
  let worker: Worker | undefined;
  let workerError: Error | undefined;
  const pending = new Map<number, {
    resolve: (candidates: UncompactedConversation[]) => void;
    reject: (error: Error) => void;
  }>();

  const fail = (value: unknown): void => {
    const error = toError(value);
    workerError ??= error;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL("./session-start-compact-worker.js", import.meta.url));
    worker.on("message", (response: ScanResponse) => {
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if ("error" in response) {
        request.reject(new Error(response.error));
      } else {
        request.resolve(response.candidates);
      }
      if (pending.size === 0) worker?.unref();
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (code !== 0) fail(new Error(`SessionStart compact worker exited with code ${code}`));
    });
    worker.unref();
    return worker;
  };

  return {
    scan(paths, minTokens, cwd) {
      if (workerError) return Promise.reject(workerError);

      const id = nextId++;
      return new Promise<UncompactedConversation[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          const activeWorker = ensureWorker();
          activeWorker.ref();
          activeWorker.postMessage({ id, paths, minTokens, cwd } satisfies ScanRequest);
        } catch (error) {
          pending.delete(id);
          if (pending.size === 0) worker?.unref();
          reject(toError(error));
        }
      });
    },
  };
}
