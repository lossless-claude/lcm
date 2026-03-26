# Runtime Self-Deduplication for SessionStart Hooks

## Problem
Upgraded users have duplicate SessionStart hooks firing (old binary + plugin.json both active). The diagnose tool catches it post-hoc, but doesn't prevent duplicate work during the session.

## Solution: Runtime Early Exit
When `handleSessionStart()` (restore hook) runs, check if it has already executed in this session using a lockfile keyed to `session_id` from stdin JSON. Exit early if true.

### How It Works (as implemented)

> **Note:** The original spec used `~/.lossless-claude/locks/` with explicit SessionEnd cleanup.
> The shipped implementation uses `tmpdir()` lockfiles with sanitized names and no cleanup
> (they expire with the OS temp dir). This note documents the divergence.

1. **Receive session ID**: stdin contains `{ session_id, cwd, ... }` from Claude Code SessionStart event
2. **Check lockfile**: `{tmpdir}/lcm-restore-{safe_id}.lock` tracks if restore already ran
3. **Lock file path**: `join(tmpdir(), `lcm-restore-${safeId}.lock`)` — `safeId` strips non-alphanumeric chars
4. **Early exit**: If lock exists and contains our PID, return early immediately
5. **Create lock**: Write PID to lock file before restore logic runs
6. **Cleanup**: No explicit cleanup — temp files are ephemeral; OS reclaims on reboot

### Implementation (as shipped in `src/hooks/restore.ts`)
```typescript
const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
const lockPath = join(tmpdir(), `lcm-restore-${safeId}.lock`);

export function tryAcquireSessionLock(lockPath: string, pid: number): boolean {
  try {
    if (existsSync(lockPath)) {
      const existing = readFileSync(lockPath, "utf-8").trim();
      return existing === String(pid); // same process already holds it
    }
    writeFileSync(lockPath, String(pid), "utf-8");
    return true;
  } catch {
    return false; // fail-closed: treat unreadable lock as held
  }
}
```

**No SessionEnd cleanup** — lock files live in `tmpdir()` and are not removed on SessionEnd.

## Pros
- **Immediate effect**: No double work, no daemon load spikes
- **No daemon involvement**: Pure file-based, no new DB schema
- **Zero user impact**: Silent; users don't see any change
- **Backward compatible**: Non-existent lock files fail gracefully

## Cons
- **Lock file leaks**: If session-end fails, locks linger until next session (minor; they auto-clean after ~1 session)
- **No atomicity**: Race if two hooks fire simultaneously (extremely rare in practice; session_id is unique per Claude Code session)
- **File I/O overhead**: Tiny; ~1ms per hook fire

## Scoring
| Metric | Score | Notes |
|--------|-------|-------|
| **Effort** | 2/5 | ~15 lines of code; uses stdlib `fs` |
| **Reliability** | 4/5 | File locks are proven; race window is near-zero (Claude Code serializes hooks) |
| **User Impact** | 5/5 | Silent, fixes the problem immediately during session |

## Session ID Availability
✓ Available in stdin JSON: `{ session_id: "uuid", cwd: "...", ... }`  
✓ Comes from Claude Code on every SessionStart event  
✓ Unique per session; no collisions

## Alternative: Daemon-Side Check
Store last session_id in daemon memory, reject duplicate SessionStart from same session. Trade-off: requires daemon restart handling, adds complexity.
