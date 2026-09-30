/** An `lcm` executable word: optionally quoted, optionally a path, optionally a `.js` entry point. */
const LCM_WORD = /^["']?(?:[^\s"']*[\/\\])?lcm(?:\.(?:m?js|cjs))?["']?$/;

/** Structural recovery only: a copied successful claim never grants admission. */
export function isWorkerClaim(name: unknown, input?: Record<string, unknown>): boolean {
  if (typeof name !== "string") return false;
  if (/(?:^|__)lcm_summarize_claim$/.test(name)) return true;
  const command = input?.command ?? input?.cmd;
  return ["Bash", "exec_command"].includes(name) && typeof command === "string" && invokesSummarizeClaim(command);
}

/**
 * `lcm summarize-claim`, separated by whitespace only, and ending the command or followed by
 * whitespace. Scans the words once: a regular expression over the whole command backtracks
 * quadratically on long runs of `;`, `&` or `|`.
 */
function invokesSummarizeClaim(command: string): boolean {
  let previous: { word: string; end: number } | undefined;
  for (const match of command.matchAll(/[^\s;&|]+/g)) {
    const end = match.index + match[0].length;
    if (match[0] === "summarize-claim" && previous && (end === command.length || /\s/.test(command[end]!))
      && /^\s+$/.test(command.slice(previous.end, match.index)) && LCM_WORD.test(previous.word)) return true;
    previous = { word: match[0], end };
  }
  return false;
}

/**
 * The ids of the jobs a successful claim result carries. Only the id makes it a payload: the
 * daemon records every job it issues, so output merely shaped like a job is not one.
 */
export function workerPayloadJobIds(output: unknown): string[] {
  if (typeof output === "string") {
    try { return workerPayloadJobIds(JSON.parse(output)); } catch { return []; }
  }
  if (Array.isArray(output)) return output.flatMap(workerPayloadJobIds);
  if (!output || typeof output !== "object") return [];
  const object = output as Record<string, unknown>;
  if (object.isError === true || object.is_error === true || typeof object.error === "string") return [];
  const job = object.job as Record<string, unknown> | undefined;
  if (job && typeof job.id === "string" && job.id && typeof job.prompt === "string" && typeof job.system === "string") return [job.id];
  return [
    ...(typeof object.text === "string" ? workerPayloadJobIds(object.text) : []),
    ...(Array.isArray(object.content) ? workerPayloadJobIds(object.content) : []),
  ];
}
