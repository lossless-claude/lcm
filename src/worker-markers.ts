/** Structural recovery only: a copied successful claim never grants admission. */
export function isWorkerClaim(name: unknown, input?: Record<string, unknown>): boolean {
  if (typeof name !== "string") return false;
  if (/(?:^|__)lcm_summarize_claim$/.test(name)) return true;
  const command = input?.command ?? input?.cmd;
  return ["Bash", "exec_command"].includes(name) && typeof command === "string" && /(?:^|\s)lcm\s+summarize-claim(?:\s|$)/.test(command);
}

export function containsWorkerPayload(output: unknown): boolean {
  if (typeof output === "string") {
    try { return containsWorkerPayload(JSON.parse(output)); } catch { return false; }
  }
  if (Array.isArray(output)) return output.some(containsWorkerPayload);
  if (!output || typeof output !== "object") return false;
  const object = output as Record<string, unknown>;
  const job = object.job as Record<string, unknown> | undefined;
  if (job && typeof job.prompt === "string" && typeof job.system === "string") return true;
  return typeof object.text === "string" && containsWorkerPayload(object.text) ||
    Array.isArray(object.content) && containsWorkerPayload(object.content);
}
