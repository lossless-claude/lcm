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

  const { findUncompacted } = await import("../batch-compact.js");
  port.on("message", (request: ScanRequest) => {
    try {
      port.postMessage({
        id: request.id,
        candidates: findUncompacted(request.paths, request.minTokens, false, request.cwd),
      } satisfies ScanResponse);
    } catch (error) {
      port.postMessage({ id: request.id, error: toError(error).message } satisfies ScanResponse);
    }
  });
}

export function createSessionStartCompactScanner(): SessionStartCompactScanner {
  const worker = new Worker(new URL("./session-start-compact-worker.js", import.meta.url), {
    type: "module",
  });
  worker.unref();

  let nextId = 0;
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

  worker.on("message", (response: ScanResponse) => {
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if ("error" in response) {
      request.reject(new Error(response.error));
    } else {
      request.resolve(response.candidates);
    }
  });
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`SessionStart compact worker exited with code ${code}`));
  });

  return {
    scan(paths, minTokens, cwd) {
      if (workerError) return Promise.reject(workerError);

      const id = nextId++;
      return new Promise<UncompactedConversation[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, paths, minTokens, cwd } satisfies ScanRequest);
        } catch (error) {
          pending.delete(id);
          reject(toError(error));
        }
      });
    },
  };
}
