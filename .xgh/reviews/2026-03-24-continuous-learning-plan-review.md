# Plan Review: Continuous Mid-Session Learning

**Reviewed:** `.xgh/plans/2026-03-24-continuous-learning.md`
**Against:** `.xgh/specs/2026-03-24-continuous-learning-design.md`
**Date:** 2026-03-24
**Verdict:** All Issues Resolved

---

## What Was Done Well

- Strong TDD discipline: every task writes the test first, runs it to see failure, implements, then verifies.
- The dependency graph is correct and clearly documented. Tasks 1-6 are truly independent. Tasks 7 and 9 correctly depend on Task 3. Task 10 is the integration capstone.
- Code snippets are realistic, match existing patterns (DI via interfaces, fire-and-forget via `socket.unref()`), and import from correct paths.
- Error handling philosophy is consistent with the spec: exit 0 always, log to `auto-heal.log`.

---

## Issues

### Critical

**C1. Wrong migration test file path (Task 2)**

The plan references `test/db/migration.test.ts` but the file is at `test/migration.test.ts`. An implementing agent will create a new file in the wrong location.

**C2. Existing test breaks on Task 5 (UserPromptSubmit changes)**

`test/hooks/user-prompt.test.ts` line 40 asserts `expect(result.stdout).toBe("")` when hints are empty. After Task 5 injects `<learning-instruction>` on every response (including empty hints), this test will fail because stdout will now contain the instruction block. The plan does not mention updating this existing test.

**C3. Existing test breaks on Task 6 (SessionEnd changes)**

`test/hooks/session-end.test.ts` has tests asserting that compact does NOT fire when below the threshold (lines 58-64, 66-75). Task 6 removes the threshold, making compact always fire. These existing tests will fail. The plan's Task 6 tests are skeletal stubs with comments like "The exact assertion depends on..." but does not address updating or removing the contradicted tests.

**C4. dispatch.test.ts breaks on Task 4/7 (HOOK_COMMANDS change)**

The existing `test/hooks/dispatch.test.ts` has a hardcoded `commandToEvent` map (lines 35-39) that maps every `HOOK_COMMANDS` entry. Adding `"session-snapshot"` to `HOOK_COMMANDS` without updating this test will cause a failure. The plan does not mention updating this existing test.

### Important

**I1. Task 6 is underspecified -- `firePromoteRequest` and manifest recording**

Task 6 says "Add `firePromoteRequest` using the same pattern as `fireCompactRequest`" but provides no implementation. It also says "Record session completion" (spec requirement: write to `session_ingest_log`) but the implementation snippet for Task 6 contains no code for this. The promote endpoint is `POST /promote` and requires `{ cwd }` -- this is correct in the snippet but the manifest write is missing entirely. An implementer will not know how to record the manifest.

**I2. Task 3 -- `ensureBootstrapped` uses hardcoded `existsSync`/`writeFileSync` instead of injected deps**

The `ensureBootstrapped()` function in the plan uses the real `existsSync` and `writeFileSync` from `node:fs` for the flag file, but the rest of the function accepts `deps`. This makes the flag file logic untestable in isolation. There is no test for `ensureBootstrapped` either -- only `ensureCore` is tested.

**I3. Task 3 -- import path may be wrong**

`src/bootstrap.ts` imports from `"../installer/install.js"` to get `mergeClaudeSettings`. Given the source file is at `src/bootstrap.ts` and the target is `installer/install.ts`, the relative path `../installer/install.js` is correct only if `src/` and `installer/` are siblings at the project root. This appears correct based on the directory structure, but should be verified against the TypeScript `paths`/`rootDir` config. If the build output flattens differently, this will break at runtime.

**I4. Task 8 is too vague**

Task 8 ("lcm import idempotency check") has placeholder test code with comments instead of actual assertions. The implementation step says "check if the session_id exists in `session_ingest_log`" but doesn't specify how to get a database handle in the import context (the daemon owns the DB, not the CLI). An implementer will need to figure out the entire wiring independently.

**I5. Task 7 -- dispatch test uses `vi.doMock` incorrectly**

The dispatch test in Task 7 uses `vi.doMock("../src/bootstrap.js", ...)` but `dispatchHook` imports from `"../bootstrap.js"` (relative to `src/hooks/dispatch.ts`). The mock path should match what vitest resolves, which varies by config. The test also uses a bare `try {} catch {}` around `dispatchHook` and asserts after, but if bootstrap is called inside a `try/catch` in the implementation (as shown in Step 3), the mock may never be invoked. This test is fragile and may produce a false positive.

### Suggestions

**S1. Parallelization opportunity for Tasks 7 and 9**

The dependency graph shows Task 7 and Task 9 both depend on Task 3 but are independent of each other. The plan text at line 989 correctly states this. No issue, just confirming.

**S2. Task 10 e2e tests are skeleton-only**

All assertions in Task 10 are comments, not code. This is understandable for an e2e test that depends on LLM behavior, but the plan should at minimum provide the test infrastructure (daemon setup/teardown, fixture loading, promoted table querying) as concrete code. Currently an implementer gets zero runnable code.

**S3. Consider adding `session-snapshot` to `REQUIRED_HOOKS` in `installer/install.ts`**

The plan adds the Stop hook to `plugin.json` but does not add it to the `REQUIRED_HOOKS` array in `installer/install.ts`. If the hook should also be registered for standalone (non-plugin) installs, this needs an entry. If plugin-only, it should be explicitly noted.

---

## Spec Coverage Analysis

| Spec Scope Item | Plan Task | Status |
|---|---|---|
| `ensureCore()` extracted from `install()` | Task 3, Task 9 | Covered |
| `ensureBootstrapped(sessionId)` in every hook | Task 7 | Covered |
| `lcm session-snapshot` subcommand | Task 4 | Covered |
| Stop hook registration in plugin.json | Task 4 Step 7 | Covered |
| UserPromptSubmit `<learning-instruction>` injection | Task 5 | Covered |
| SessionEnd: remove threshold, always compact + promote | Task 6 | Partially covered (I1) |
| `hooks.snapshotIntervalSec` config field | Task 1 | Covered |
| `hooks.disableAutoCompact` config field | Task 1 | Covered |
| SQLite ingestion manifest table | Task 2 | Covered |
| `lcm import` idempotency check | Task 8 | Underspecified (I4) |
| Synthetic session quality test | Task 10 | Skeleton only (S2) |
| SessionEnd records completion in manifest | Task 6 | Missing from implementation (I1) |
| Cursor file left to OS cleanup (not deleted by SessionEnd) | N/A | Implicitly covered (no delete code) |
| `autoCompactMinTokens` deprecation + `disableAutoCompact` migration | Task 1 + Task 6 | Config added but no migration note in code |

---

## Questions for Plan Author

1. **Manifest recording**: Where should `session_ingest_log` be written from in Task 6? The SessionEnd hook runs in the CLI process but the DB is accessed by the daemon. Should there be a new thin daemon endpoint, or should the hook write directly via SQLite?

2. **Existing test updates**: Should the plan include explicit steps for updating the 4+ existing tests that will break? Or is the expectation that the implementer handles this implicitly?

3. **`REQUIRED_HOOKS` for Stop**: Should `session-snapshot` be added to the `REQUIRED_HOOKS` array in `installer/install.ts`, or is it plugin-only?
