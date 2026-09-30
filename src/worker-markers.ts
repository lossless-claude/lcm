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

export function containsWorkerPayload(output: unknown): boolean {
  if (typeof output === "string") {
    try { return containsWorkerPayload(JSON.parse(output)); } catch { return false; }
  }
  if (Array.isArray(output)) return output.some(containsWorkerPayload);
  if (!output || typeof output !== "object") return false;
  const object = output as Record<string, unknown>;
  if (object.isError === true || object.is_error === true || typeof object.error === "string") return false;
  const job = object.job as Record<string, unknown> | undefined;
  if (job && typeof job.prompt === "string" && typeof job.system === "string") return true;
  return typeof object.text === "string" && containsWorkerPayload(object.text) ||
    Array.isArray(object.content) && containsWorkerPayload(object.content);
}
