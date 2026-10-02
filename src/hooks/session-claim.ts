import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A session claim: the file hooks/lcm-hooks.ts writes to say the function-hooks module
 * loaded and is doing the command hooks' work for this session. The module rewrites it
 * on every classic hook event a claim-reading command hook listens to, before that
 * command hook runs, and overwrites it with `ended` at `session.end`.
 *
 * The file lives in the temp dir because the claim must not outlive the session, and
 * because that is one of the two places the module's `$.fs` may write. Same shape as
 * the restore lock next to it.
 */
export type SessionClaim = { sessionId: string; ts: number; ended?: string };

/**
 * How old a claim may be and still count. The module rewrites the claim inside the same
 * event chain, just before the command hook reads it, so a live module's claim is
 * milliseconds old; the window only absorbs a command hook that is slow to start. A
 * crash skips `session.end`, and its claim stops counting once the window passes.
 */
export const CLAIM_FRESH_MS = 60_000;

/** The function module uses this injective encoding for claim filenames. */
function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/[_.!~*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export function claimPath(sessionId: string): string {
  return join(tmpdir(), `lcm-claim-${safeSessionId(sessionId)}.json`);
}

/**
 * Whether the function-hooks module owns this session's capture, so a command hook
 * doing the same work would double it.
 *
 * Only the module can answer that. Claude Code may load it with or without any setting,
 * and a validation error, a stripped `$`, mods turned off or an older build leave
 * nothing registered; a command hook that assumed otherwise would fall silent with no
 * replacement, and the session would record nothing at all.
 *
 * So anything short of a fresh, unwithdrawn claim naming this session means no.
 * Capturing an event twice is a row the dedup key drops; capturing it zero times is
 * gone for good.
 */
export function functionHooksOwnSession(sessionId: string | undefined, now = Date.now()): boolean {
  if (!sessionId) return false;
  try {
    const claim = JSON.parse(readFileSync(claimPath(sessionId), "utf-8")) as Partial<SessionClaim>;
    return claim.sessionId === sessionId && claim.ended === undefined
      && typeof claim.ts === "number" && now - claim.ts < CLAIM_FRESH_MS;
  } catch {
    return false;
  }
}
