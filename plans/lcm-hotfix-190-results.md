# lcm-hotfix-190 Results

## Status: COMPLETE

## Issues Fixed

| Issue | Severity | Status | PR |
|-------|----------|--------|----|
| #191 — compact HTTP 401 (missing auth token) | P0 | ✅ Fixed | #196 |
| #192 — `lcm` not on PATH for marketplace users | P1 | ✅ Fixed | #196 |
| #193 — fragile glob patterns in lcm-stats/lcm-doctor | P1 | ✅ Fixed | #196 |
| #194 — no actionable remediation in doctor warning | P2 | ✅ Fixed | #196 |
| #190 — bare `lcm` failing (Binary Resolution section) | P0 | ✅ Fixed | #195 (prior session) |

## PRs

- **#195** (prior session): Fix #190 — removed fragile Binary Resolution section from 7 command files
- **#196** (this session): Fix #191–194 — auth, PATH, glob, doctor UX

## Changes

- `src/batch-compact.ts` — replaced raw `fetch()` with `DaemonClient.post()` for auth
- `bin/lcm.ts` — propagated `tokenPath` to `batchCompact()`
- `lcm.mjs` — removed `LCM_BOOTSTRAP_INSTALL=1` gate
- `.claude-plugin/commands/lcm-stats.md` — `${CLAUDE_PLUGIN_ROOT}/lcm.mjs` fallback
- `.claude-plugin/commands/lcm-doctor.md` — `${CLAUDE_PLUGIN_ROOT}/lcm.mjs` fallback
- `src/doctor/doctor.ts` — actionable remediation in events-capture warning

## Tests

- 936/938 pass overall
- 2 pre-existing flaky timeouts in `stats.test.ts` — unrelated to changes
- 49 targeted tests (compact, doctor, bin/compact-routing, hooks/compact) — all pass
