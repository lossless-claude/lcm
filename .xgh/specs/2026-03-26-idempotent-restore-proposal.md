# Idempotent Restore via Session Scoping

## Problem
Users upgrading from binary-based hooks (written to `~/.claude/settings.json`) to plugin-based system (`plugin.json`) end up with duplicate `SessionStart` hooks firing. Each invocation loads context twice, wasting resources. The diagnose tool detects this after the fact but doesn't prevent it.

## Proposed Solution
Make `restore` fully idempotent by checking a session-scoped lock file on first run, then returning early on duplicates.

### How It Works
1. **Hook receives `session_id` in stdin** (already available in `/hooks/dispatch.ts` line 23: `const { session_id }`)
2. **Lock file path**: `${tmpdir()}/lcm-restore-${sessionId}.lock`
3. **In `handleSessionStart` (src/hooks/restore.ts)**:
   - Before calling `client.post("/restore", ...)`, check if lock exists
   - If exists: return `{ exitCode: 0, stdout: "" }` immediately (success, no-op)
   - If not: write lock file, proceed normally, let lock expire naturally at session end

### Implementation Sketch
```typescript
// src/hooks/restore.ts (pseudo-code)
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function handleSessionStart(stdin: string, client, port) {
  const input = JSON.parse(stdin || "{}");
  const sessionId = input.session_id;
  
  if (sessionId) {
    const lockPath = join(tmpdir(), `lcm-restore-${sessionId}.lock`);
    if (existsSync(lockPath)) {
      return { exitCode: 0, stdout: "" };  // Already ran this session
    }
    try {
      writeFileSync(lockPath, "", { flag: "wx" }); // exclusive write
    } catch {
      // Race: another hook instance beat us. Safe to return early.
      return { exitCode: 0, stdout: "" };
    }
  }
  
  // ... rest of existing logic
}
```

### Pros
- **Zero coordination required**: No settings.json mutation, no daemon state, no old binary awareness
- **Automatic cleanup**: Lock disappears when session exits (tmpdir is per-session on most systems)
- **Race-safe**: `flag: "wx"` ensures only one winner
- **Non-invasive**: Wraps existing logic, no changes to restore business logic
- **Works on all platforms**: Uses Node's `tmpdir()` (handles `/tmp` → `/private/tmp` symlinks)

### Cons
- **Assumes stable session_id**: If hook receives different session_id on retry (shouldn't happen), will run twice. Mitigation: session_id is set by Claude Code, not user-mutable.
- **Doesn't clean up old locks**: If Claude Code crashes, lock remains until tmpdir cleanup. Not a problem in practice (read-only file, no space leak), but leaves breadcrumbs.
- **Doesn't solve root cause**: Still leaves duplicate hooks in settings.json. Diagnose tool can still offer cleanup, but now idempotency prevents harm while users migrate.

## Effort / Reliability / Impact Scoring
| Metric | Score | Notes |
|--------|-------|-------|
| **Effort** | 2/5 | ~15 lines in one file, reuses existing patterns (`tmpdir` already imported in codex-process.ts) |
| **Reliability** | 5/5 | Session IDs are stable, `existsSync` + `writeFileSync` with `wx` flag is bulletproof |
| **User Impact** | 4/5 | Eliminates duplicate context injection during upgrade period; doesn't nag user to clean up settings.json |

## Recommendation
**Pursue this approach.** It's surgical (one file, two error handlers), leverages existing session_id, and makes the system resilient to duplicate hooks without requiring user intervention or settings.json cleanup logic.
