export const WORKER_WARNING = "This session and its subagents are not recorded by lcm. The harness's own transcript stays on disk. Use a dedicated session; forking a worker session is unsupported.";

export function workerRefusal(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.includes(WORKER_WARNING) ? message : `${message} ${WORKER_WARNING}`);
}
