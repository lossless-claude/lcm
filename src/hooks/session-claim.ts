import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A session claim: the file hooks/lcm-hooks.ts writes at session.start to say the
 * function-hooks module loaded and is doing the command hooks' work for this session.
 *
 * The file lives in the temp dir because the claim must not outlive the session, and
 * because that is one of the two places the module's `$.fs` may write. Same shape as
 * the restore lock next to it.
 */
export type SessionClaim = { sessionId: string; ts: number };

/** Filenames must survive a session id from any host, as in session-snapshot.ts. */
function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function claimPath(sessionId: string): string {
  return join(tmpdir(), `lcm-claim-${safeSessionId(sessionId)}.json`);
}

/** Whether Claude Code's function-hooks gate is open at all. */
export function functionHooksActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1";
}

/**
 * Whether the function-hooks module owns this session's capture, so a command hook
 * doing the same work would double it.
 *
 * The gate variable alone does not answer that. It says the host would load a module,
 * not that this one did: a validation error, a stripped `$`, or an older build leaves
 * the variable at "1" with nothing registered, and a hook that trusted it would fall
 * silent with no replacement — the session records nothing at all.
 *
 * So the module has to say so itself, and anything short of a claim it wrote means no.
 * Capturing an event twice is a row the dedup key drops; capturing it zero times is
 * gone for good.
 */
export function functionHooksOwnSession(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!functionHooksActive(env) || !sessionId) return false;
  try {
    const claim = JSON.parse(readFileSync(claimPath(sessionId), "utf-8")) as SessionClaim;
    return claim.sessionId === sessionId;
  } catch {
    return false;
  }
}
