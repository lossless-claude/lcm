# Runtime Self-Deduplication for SessionStart Hooks

## Problem
Upgraded users have duplicate SessionStart hooks firing (old binary + plugin.json both active). The diagnose tool catches it post-hoc, but doesn't prevent duplicate work during the session.

## Solution: Runtime Early Exit
When `handleSessionStart()` (restore hook) runs, check if it has already executed in this session using a lockfile keyed to `session_id` from stdin JSON. Exit early if true.

### How It Works
1. **Receive session ID**: stdin contains `{ session_id, cwd, ... }` from Claude Code SessionStart event
2. **Check lockfile**: `~/.lossless-claude/locks/{session_id}.lock` tracks if restore already ran
3. **Lock file path**: `join(homedir(), ".lossless-claude", "locks", `${session_id}.lock`)`
4. **Early exit**: If lock exists, return `{ exitCode: 0, stdout: "" }` immediately
5. **Create lock**: Write session_id to lock file on successful first run
6. **Cleanup**: Session-end hook deletes the lock file

### Implementation Sketch
```typescript
// In restore.ts: handleSessionStart()
export async function handleSessionStart(stdin: string, ...): Promise<{ exitCode: number; stdout: string }> {
  const input = JSON.parse(stdin || "{}");
  const sessionId = input.session_id;
  const lockPath = join(homedir(), ".lossless-claude", "locks", `${sessionId}.lock`);

  // Early exit if already ran this session
  if (sessionId && existsSync(lockPath)) {
    return { exitCode: 0, stdout: "" };
  }

  // ... existing logic (daemon startup, scavenge, restore) ...

  // Create lock after successful run
  if (sessionId) {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, sessionId, "utf-8");
  }

  return { exitCode: 0, stdout };
}
```

**Cleanup in session-end.ts**:
```typescript
if (sessionId) {
  rmSync(lockPath, { force: true });
}
```

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
