# Proposal: Version-Stamped Session Marker for Hook Deduplication

## Problem
When users upgrade from old binary-based hooks in `~/.claude/settings.json` (e.g., `lossless-claude restore`) to plugin.json, both fire on SessionStart. The doctor catches and removes duplicates after the fact, but doesn't prevent double-firing during upgrade windows.

## Solution: SessionStart Marker Flag
**How it works:**
1. Plugin's SessionStart hook writes a session-level marker file: `/tmp/lcm-session-{sessionId}.lock` (touch-only, no content)
2. Old binary's restored hooks check for this marker at entry; if present, exit immediately with code 0
3. On SessionEnd, marker is cleaned up
4. No coordination needed—old binary simply checks for the presence of a file in a known location

**Environment context available:**
- `process.env.CLAUDE_PROJECT_DIR` (hook stdin passes cwd)
- Session ID: not exposed by Claude, but `/tmp` isolation per-session is acceptable
- No need for version stamping—simple existence check suffices

## Implementation Sketch

**In plugin SessionStart (src/hooks/restore.ts):**
```typescript
const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
const markerPath = join('/tmp', `lcm-session-${sessionId}.lock`);
writeFileSync(markerPath, '');  // Create marker before daemon call
```

**In old binary (if still installed):**
The hook command in settings.json would become:
```bash
sh -c 'test -f /tmp/lcm-session-*.lock && exit 0 || exec lossless-claude restore'
```
Or—if Claude passes session ID via env—check specifically:
```bash
test -f "/tmp/lcm-session-${CLAUDE_SESSION_ID}.lock" && exit 0
```

**Cleanup in SessionEnd (src/hooks/session-end.ts):**
```typescript
const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
const markerPath = join('/tmp', `lcm-session-${sessionId}.lock`);
try { unlinkSync(markerPath); } catch {}
```

## Pros
- Requires zero coordination—old binary doesn't need changes; it just checks existence
- No version management; marker is session-local and ephemeral
- Works even if old binary isn't installed (no-op on missing file)
- No file system pollution; `/tmp` cleans on reboot
- Idempotent; safe to call multiple times

## Cons
- Depends on Claude providing `CLAUDE_SESSION_ID` env var (currently unavailable per grep results)
- Fallback to `sessionId='default'` breaks multi-session dedupe (unlikely in practice, but possible)
- Requires coordinating shell vs Node: old binary hook may be shell script, needs to handle session ID injection
- Marker cleanup failure silently ignores errors (acceptable but masks issues)

## Effort / Reliability / Impact Scores
- **Effort**: 2/5 (3 small file writes, one env var check)
- **Reliability**: 4/5 (works if env var provided; degrades gracefully to 'default' fallback)
- **User Impact**: 4/5 (prevents double-firing during upgrade; no UX changes; requires no user action)

## Recommendation
**Viable but blocked on `CLAUDE_SESSION_ID` availability.** If Claude Desktop doesn't expose this, fall back to a probabilistic UUID in `/tmp` written by first hook, verified by second. Alternatively, wait for doctor's `mergeClaudeSettings()` to fully clean hooks (already implemented); this marker is optimization, not necessity.
