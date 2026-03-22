# LCM E2E Test Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add E2E integration tests and user-facing validation to lossless-claude, covering the full pipeline from session ingest through compaction, promotion, and retrieval.

**Architecture:** Unified test harness with mock/live mode flag. Mock mode swaps only the summarizer (deterministic CI). Live mode uses a real LLM with relaxed assertions (user-facing skill). Three production prerequisites (promote route, status route, summarizer DI) are built first, then the harness, then plugin commands and skill.

**Tech Stack:** TypeScript, Vitest, Node.js SQLite, existing daemon HTTP server

**Spec:** `.xgh/specs/2026-03-22-lcm-e2e-test-strategy-design.md`

---

## File Structure

### New Production Files
- `src/daemon/routes/promote.ts` — `/promote` route handler
- `src/daemon/routes/status.ts` — `/status` route handler
- `src/llm/mock-summarizer.ts` — Canned summarizer for E2E mock mode

### Modified Production Files
- `src/daemon/server.ts` — Register `/promote` and `/status` routes
- `src/daemon/routes/compact.ts` — Remove inline promotion, add summarizer DI
- `src/daemon/config.ts` — Add `summarizer.mock` config option
- `bin/lcm.ts` — Add `promote` and enhance `status` subcommands

### New Test Files
- `test/e2e/harness.ts` — `createHarness()` + `HarnessHandle`
- `test/e2e/flows/environment.test.ts`
- `test/e2e/flows/import.test.ts`
- `test/e2e/flows/compact.test.ts`
- `test/e2e/flows/promote.test.ts`
- `test/e2e/flows/curate.test.ts`
- `test/e2e/flows/retrieval.test.ts`
- `test/e2e/flows/hooks.test.ts`
- `test/e2e/flows/resilience.test.ts`
- `test/e2e/flows/infrastructure.test.ts`
- `test/fixtures/e2e/session-main.jsonl`
- `test/fixtures/e2e/subagents/subagent-task-1.jsonl`

### New Test Files (Unit Tests for Prerequisites)
- `test/daemon/routes/promote.test.ts`
- `test/daemon/routes/status.test.ts`
- `test/llm/mock-summarizer.test.ts`

### New Plugin Files
- `.claude-plugin/commands/lcm-compact.md`
- `.claude-plugin/commands/lcm-promote.md`
- `.claude-plugin/commands/lcm-curate.md`
- `.claude-plugin/commands/lcm-status.md`
- `.claude-plugin/skills/lcm-e2e/SKILL.md`
- `.claude-plugin/skills/lcm-e2e/checklist.md`

### Modified Plugin Files
- `.claude-plugin/commands/lcm-import.md` — Surface all CLI params

---

## Task 1: Extract Promotion into Standalone Route

**Files:**
- Create: `src/daemon/routes/promote.ts`
- Create: `test/daemon/routes/promote.test.ts`
- Modify: `src/daemon/routes/compact.ts`
- Modify: `src/daemon/server.ts`
- Modify: `test/daemon/routes/compact.test.ts`

- [ ] **Step 1: Write the failing test for `/promote` route**

Create `test/daemon/routes/promote.test.ts`. The route accepts `{ cwd }`, reads summaries from the project DB, runs `shouldPromote()` on each, calls `deduplicateAndInsert()` for promotable ones, and returns `{ processed, promoted }`.

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";

describe("createPromoteHandler", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("returns processed:0 promoted:0 when no summaries exist", async () => {
    // Setup: empty DB with no summaries
    // Call the handler with { cwd: tmpDir }
    // Assert: { processed: 0, promoted: 0 }
  });

  it("promotes a summary that matches keyword signals", async () => {
    // Setup: DB with one summary containing "We decided to use PostgreSQL"
    // Call handler
    // Assert: { processed: 1, promoted: 1 }
    // Assert: PromotedStore has one entry
  });

  it("skips summaries that don't meet promotion thresholds", async () => {
    // Setup: DB with one shallow, low-signal summary
    // Assert: { processed: 1, promoted: 0 }
  });

  it("respects dry_run flag", async () => {
    // Setup: DB with promotable summary
    // Call with { cwd, dry_run: true }
    // Assert: { processed: 1, promoted: 1 } but PromotedStore is empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/promote.test.ts`
Expected: FAIL — `createPromoteHandler` not found

- [ ] **Step 3: Implement `/promote` route handler**

Create `src/daemon/routes/promote.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectId, projectDbPath, projectDir, ensureProjectDir, projectMetaPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { PromotedStore } from "../../db/promoted.js";
import { shouldPromote } from "../../promotion/detector.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import type { LcmSummarizeFn } from "../../llm/types.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function createPromoteHandler(
  config: DaemonConfig,
  getSummarizer: () => LcmSummarizeFn,
): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { cwd, dry_run } = input;

    if (!cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { processed: 0, promoted: 0 });
      return;
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      const conversationStore = new ConversationStore(db);
      const summaryStore = new SummaryStore(db);
      const promotedStore = new PromotedStore(db);
      const pid = projectId(cwd);

      // Use ConversationStore to get conversations (consistent with codebase patterns)
      const conversations = await conversationStore.listConversations();

      let processed = 0;
      let promoted = 0;

      for (const conversation of conversations) {
        const summaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
        for (const summary of summaries) {
          processed++;
          const result = shouldPromote(
            {
              content: summary.content,
              depth: summary.depth,
              tokenCount: summary.tokenCount,
              sourceMessageTokenCount: summary.sourceMessageTokenCount,
            },
            config.compaction.promotionThresholds,
          );

          if (result.promote && !dry_run) {
            const summarize = getSummarizer();
            await deduplicateAndInsert({
              store: promotedStore,
              content: summary.content,
              tags: result.tags,
              projectId: pid,
              sessionId: conversation.sessionId, // preserve session provenance
              depth: summary.depth,
              confidence: result.confidence,
              summarize,
              thresholds: {
                dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                mergeMaxEntries: config.compaction.promotionThresholds.mergeMaxEntries,
                confidenceDecayRate: config.compaction.promotionThresholds.confidenceDecayRate,
              },
            });
            promoted++;
          } else if (result.promote) {
            promoted++; // dry_run: count but don't insert
          }
        }
      }

      // Update meta.json with lastPromote timestamp
      try {
        const metaPath = projectMetaPath(cwd);
        let meta: Record<string, unknown> = {};
        if (existsSync(metaPath)) {
          meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        }
        if (!dry_run) {
          meta.lastPromote = new Date().toISOString();
          writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
      } catch { /* non-fatal */ }

      sendJson(res, 200, { processed, promoted });
    } finally {
      db.close();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/routes/promote.test.ts`
Expected: PASS

- [ ] **Step 5: Remove inline promotion from compact route**

In `src/daemon/routes/compact.ts`, remove the "Promote worthy summaries" block (~30 lines starting at the `let promotedCount = 0` line through the `catch { /* non-fatal */ }` block). Keep the `buildCompactionMessage` call but hardcode `promotedCount: 0`.

- [ ] **Step 6: Verify existing compact tests still pass**

Run: `npx vitest run test/daemon/routes/compact.test.ts`
Expected: PASS (promotion-related assertions may need updating)

- [ ] **Step 7: Register `/promote` route in daemon server**

In `src/daemon/server.ts`:
- Add import: `import { createPromoteHandler } from "./routes/promote.js";`
- Add route: `routes.set("POST /promote", createPromoteHandler(config, getSummarizer));`
- Extract the summarizer creation logic from compact into a shared `getSummarizer()` function that both compact and promote can use.

- [ ] **Step 8: Add `lcm promote` CLI subcommand**

In `bin/lcm.ts`, add a `case "promote"` block following the pattern of the `import` subcommand:
- Parse `--all`, `--verbose`, `--dry-run` flags
- Ensure daemon is running
- POST to `/promote` with `{ cwd, dry_run }`
- Print results

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/daemon/routes/promote.ts test/daemon/routes/promote.test.ts src/daemon/routes/compact.ts src/daemon/server.ts bin/lcm.ts
git commit -m "feat: extract promotion into standalone /promote route and lcm promote CLI"
```

---

## Task 2: Enhance `lcm status` with `/status` Route

**Files:**
- Create: `src/daemon/routes/status.ts`
- Create: `test/daemon/routes/status.test.ts`
- Modify: `src/daemon/server.ts`
- Modify: `bin/lcm.ts`

- [ ] **Step 1: Write the failing test for `/status` route**

```typescript
import { describe, it, expect } from "vitest";

describe("createStatusHandler", () => {
  it("returns daemon info and project stats for valid cwd", async () => {
    // Setup: DB with messages, summaries, promoted entries
    // Assert: response includes messageCount, summaryCount, promotedCount, timestamps
  });

  it("returns zeros for project with no data", async () => {
    // Assert: all counts are 0, timestamps are null
  });

  it("includes daemon uptime and version", async () => {
    // Assert: uptime is a number, version matches PKG_VERSION
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/status.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `/status` route handler**

Create `src/daemon/routes/status.ts`. Queries the project database for:
- Message count (from `messages` table)
- Summary count (from `summaries` table)
- Promoted count (from `promoted` table)
- Last timestamps from `meta.json` (lastCompact, lastPromote)
- Add `lastIngest` tracking to the ingest route (update `meta.json` after successful ingest)
- Daemon uptime from server start time, version from `PKG_VERSION`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/routes/status.test.ts`
Expected: PASS

- [ ] **Step 5: Register route and enhance CLI**

- Register `POST /status` in `src/daemon/server.ts`
- Enhance `case "status"` in `bin/lcm.ts` to POST to `/status` and format the response
- Add `--json` flag support

- [ ] **Step 6: Add `lastIngest` timestamp to ingest route**

In `src/daemon/routes/ingest.ts`, after successful ingest, update `meta.json` with `lastIngest` timestamp (same pattern as `lastCompact` in compact.ts).

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/daemon/routes/status.ts test/daemon/routes/status.test.ts src/daemon/server.ts bin/lcm.ts src/daemon/routes/ingest.ts
git commit -m "feat: add /status route and enhance lcm status CLI"
```

---

## Task 3: Add Summarizer DI (Mock Summarizer)

**Files:**
- Create: `src/llm/mock-summarizer.ts`
- Create: `test/llm/mock-summarizer.test.ts`
- Modify: `src/daemon/config.ts`
- Modify: `src/daemon/routes/compact.ts`

- [ ] **Step 1: Write the failing test for MockSummarizer**

```typescript
import { describe, it, expect } from "vitest";

describe("createMockSummarizer", () => {
  it("returns structurally valid summary text", async () => {
    // Assert: non-empty string, reasonable length
  });

  it("is deterministic for the same input", async () => {
    // Assert: same input produces same output
  });

  it("includes content-derived keywords in output", async () => {
    // Input contains "PostgreSQL" → output should mention it
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llm/mock-summarizer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement MockSummarizer**

Create `src/llm/mock-summarizer.ts`:

```typescript
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";

/**
 * Deterministic mock summarizer for E2E testing.
 * Produces structurally valid summaries by extracting key phrases from input
 * and wrapping them in a canned template. No LLM calls.
 *
 * Must match LcmSummarizeFn signature: (text, aggressive?, ctx?) => Promise<string>
 */
export function createMockSummarizer(): LcmSummarizeFn {
  return async (text: string, _aggressive?: boolean, _ctx?: SummarizeContext): Promise<string> => {
    // Extract first sentence or first 200 chars as "summary"
    const firstSentence = text.split(/[.!?\n]/)[0]?.trim() || text.slice(0, 200);
    // Deterministic hash for consistent output
    const hash = Array.from(text).reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
    return `[Mock Summary ${Math.abs(hash).toString(16).slice(0, 6)}] ${firstSentence}`;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/llm/mock-summarizer.test.ts`
Expected: PASS

- [ ] **Step 5: Add `summarizer.mock` config option**

In `src/daemon/config.ts`:
1. Add `summarizer?: { mock?: boolean }` to the `DaemonConfig` type definition
2. Add `summarizer: { mock: false }` to the `DEFAULTS` object
3. Ensure the `deepMerge` logic handles the new nested field

- [ ] **Step 6: Wire mock summarizer into compact route**

In the summarizer creation logic (now shared between compact and promote), check `config.summarizer?.mock`. If true, use `createMockSummarizer()` instead of the real LLM provider.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/llm/mock-summarizer.ts test/llm/mock-summarizer.test.ts src/daemon/config.ts src/daemon/routes/compact.ts
git commit -m "feat: add mock summarizer and config-level DI for E2E testing"
```

---

## Task 4: Create E2E Fixtures

**Files:**
- Create: `test/fixtures/e2e/session-main.jsonl`
- Create: `test/fixtures/e2e/subagents/subagent-task-1.jsonl`

- [ ] **Step 1: Study the transcript format**

Read `src/transcript.ts` to understand the exact JSONL format `parseTranscript()` expects. Each line is a JSON object with `type`, and the parser extracts `user|assistant|system` messages with `text` and `tool_result` content blocks.

- [ ] **Step 2: Create `session-main.jsonl`**

Create a 15-20 message conversation that includes:
- Mix of `user`, `assistant`, `system` roles
- At least one `tool_result` content block
- A fake API key pattern: `sk-test-FAKE-KEY-abc123def456` (for scrubbing test)
- A durable insight: "We decided to use SQLite instead of PostgreSQL because it requires zero infrastructure"
- An architecture pattern: "The ConversationStore class handles all CRUD operations for messages"
- Enough token content to exceed the default `autoCompactMinTokens` threshold
- No timestamps or UUIDs in message text

- [ ] **Step 3: Create `subagents/subagent-task-1.jsonl`**

Create a 5-message subagent conversation. Simpler content, just enough to verify subagent discovery works.

- [ ] **Step 4: Verify fixtures parse correctly**

Build first (`npm run build`), then verify the fixtures are valid JSONL:

Run: `npm run build && node -e "import('./dist/src/transcript.js').then(m => console.log(m.parseTranscript('test/fixtures/e2e/session-main.jsonl').length))"`
Expected: prints the message count (15-20)

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/e2e/
git commit -m "feat: add E2E test fixtures (session transcript + subagent)"
```

---

## Task 5: Build E2E Test Harness

**Files:**
- Create: `test/e2e/harness.ts`

- [ ] **Step 1: Write the harness interface**

```typescript
import type { DaemonClient } from "../../src/daemon/client.js";

export interface HarnessHandle {
  tmpDir: string;
  dbPath: string;
  daemonPort: number;
  client: DaemonClient;    // production DaemonClient (dogfooding)
  fixturePath: string;
  mode: "mock" | "live";
  cleanup(): Promise<void>;
}

export interface FlowResult {
  name: string;
  status: "pass" | "fail" | "skip";
  notes: string;
  durationMs: number;
}
```

- [ ] **Step 2: Implement `createHarness()`**

The function:
1. **Defensive cleanup first:** Scan `~/.lossless-claude/projects/` for directories whose `meta.json` has a `cwd` starting with the OS temp dir and an `e2e-test-` prefix. Remove any orphans from prior crashed runs.
2. Creates a temp dir with `e2e-test-` prefix
2. Copies fixtures to the temp dir
3. Picks a random free port (mock mode) or reads existing config (live mode)
4. Writes a test `config.json` with `summarizer.mock: true` (mock mode) or `summarizer.mock: false` (live mode)
5. Starts a daemon on the test port (mock mode) or connects to existing (live mode)
6. Creates a `DaemonClient` pointed at the test port
7. Returns the `HarnessHandle`

`cleanup()`:
1. Stops the daemon (mock mode only)
2. Removes temp dir
3. Removes the test project from `~/.lossless-claude/projects/<hash>/`

- [ ] **Step 3: Add helper utilities**

Add helpers the flow tests will need:
- `waitForDaemon(client, timeoutMs)` — polls `/health` until daemon responds
- `getProjectDbPath(cwd)` — returns the SQLite path for a given cwd
- `assertRowCount(db, table, expected)` — common assertion helper
- `openProjectDb(cwd)` — opens the project SQLite for assertions

- [ ] **Step 4: Verify harness starts and cleans up**

Write a minimal test that creates and destroys a harness:

```typescript
import { describe, it, expect } from "vitest";
import { createHarness } from "../harness.js";

describe("E2E harness", () => {
  it("creates and cleans up in mock mode", async () => {
    const handle = await createHarness("mock");
    expect(handle.daemonPort).toBeGreaterThan(0);
    const health = await handle.client.health();
    expect(health.status).toBe("ok");
    await handle.cleanup();
  });
}, { timeout: 30_000 });
// Note: E2E tests need longer timeouts than unit tests.
// Update vitest.config.ts to add a project-level timeout for test/e2e/**:
// test: { testTimeout: 60_000 } or use per-file { timeout } in describe blocks.
```

- [ ] **Step 5: Run test**

Run: `npx vitest run test/e2e/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/e2e/harness.ts
git commit -m "feat: add E2E test harness with mock/live mode support"
```

---

## Task 6: E2E Flow Tests — Pipeline Phase (Flows 1-7)

**Files:**
- Create: `test/e2e/flows/environment.test.ts` (Flow 1)
- Create: `test/e2e/flows/import.test.ts` (Flows 2, 3, 4)
- Create: `test/e2e/flows/compact.test.ts` (Flow 5)
- Create: `test/e2e/flows/promote.test.ts` (Flow 6)
- Create: `test/e2e/flows/curate.test.ts` (Flow 7)

Each test file uses `createHarness("mock")` in a `beforeAll` and `handle.cleanup()` in `afterAll`.

- [ ] **Step 1: Write Flow 1 — Environment**

```typescript
describe("Flow 1: Environment", () => {
  it("daemon responds to health check with version", async () => {
    const health = await handle.client.health();
    expect(health.status).toBe("ok");
    expect(health.version).toBeTruthy();
  });
});
```

- [ ] **Step 2: Write Flow 2 — Import**

```typescript
describe("Flow 2: Import", () => {
  it("ingests fixture transcript into SQLite", async () => {
    const result = await handle.client.post("/ingest", {
      session_id: "e2e-test-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    expect(result.ingested).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Write Flow 3 — Idempotent re-import**

```typescript
describe("Flow 3: Idempotent re-import", () => {
  it("re-import returns ingested:0", async () => {
    const result = await handle.client.post("/ingest", {
      session_id: "e2e-test-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    expect(result.ingested).toBe(0);
  });
});
```

- [ ] **Step 4: Write Flow 4 — Subagent import**

Subagent discovery happens in `importSessions()` (not the daemon), which scans `subagents/*.jsonl` subdirectories. Structure the temp dir to mimic Claude Code's session layout:
```
<tmpDir>/  (used as _claudeProjectsDir)
  <projectHash>/
    session-main.jsonl
    subagents/
      subagent-task-1.jsonl
```
Call `importSessions(client, { cwd: handle.tmpDir, _claudeProjectsDir: tmpDir })` directly (not via `/ingest`). Assert the subagent session is found and ingested.

- [ ] **Step 5: Write Flow 5 — Compact**

```typescript
describe("Flow 5: Compact", () => {
  it("creates DAG summary nodes", async () => {
    const result = await handle.client.post("/compact", {
      session_id: "e2e-test-session",
      cwd: handle.tmpDir,
      client: "claude",
    });
    expect(result.summary).toContain("compaction complete");
    // Verify DB: summaries table has rows, depth > 0
  });
});
```

- [ ] **Step 6: Write Flow 6 — Promote**

```typescript
describe("Flow 6: Promote", () => {
  it("promotes durable insights to promoted store", async () => {
    const result = await handle.client.post("/promote", {
      cwd: handle.tmpDir,
    });
    expect(result.processed).toBeGreaterThan(0);
    expect(result.promoted).toBeGreaterThan(0);
    // Verify DB: promoted table has rows
  });
});
```

- [ ] **Step 7: Write Flow 7 — Curate (full pipeline with fresh session)**

Uses a separate session ID. Runs ingest → compact → promote sequentially. Asserts all prior invariants hold.

- [ ] **Step 8: Run all pipeline flow tests**

Run: `npx vitest run test/e2e/flows/`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add test/e2e/flows/environment.test.ts test/e2e/flows/import.test.ts test/e2e/flows/compact.test.ts test/e2e/flows/promote.test.ts test/e2e/flows/curate.test.ts
git commit -m "test: add E2E pipeline flow tests (flows 1-7)"
```

---

## Task 7: E2E Flow Tests — Retrieval (Flows 8-10)

**Files:**
- Create: `test/e2e/flows/retrieval.test.ts` (Flows 8, 9, 10)

- [ ] **Step 1: Write Flow 8 — Retrieval tools**

Test `lcm_search`, `lcm_grep`, `lcm_expand`, `lcm_describe` against the data ingested and compacted in prior flows. Assert non-empty results with correct structure.

- [ ] **Step 2: Write Flow 9 — Restore (SessionStart hook)**

Simulate the SessionStart hook by calling `/restore` with `{ cwd, session_id }`. Assert the response contains context from prior sessions.

- [ ] **Step 3: Write Flow 10 — UserPromptSubmit**

Simulate the UserPromptSubmit hook by calling `/prompt-search`. Assert it returns `<memory-context>` hints from promoted memory.

- [ ] **Step 4: Run retrieval flow tests**

Run: `npx vitest run test/e2e/flows/retrieval.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add test/e2e/flows/retrieval.test.ts
git commit -m "test: add E2E retrieval flow tests (flows 8-10)"
```

---

## Task 8: E2E Flow Tests — Hooks & Resilience (Flows 14-19)

**Files:**
- Create: `test/e2e/flows/hooks.test.ts` (Flows 14, 15, 16)
- Create: `test/e2e/flows/resilience.test.ts` (Flows 17, 18, 19)

- [ ] **Step 1: Write Flow 14 — SessionEnd hook**

Simulate the SessionEnd hook with stdin JSON containing session data. Verify messages are ingested and auto-compact fires when token count exceeds threshold.

- [ ] **Step 2: Write Flow 15 — PreCompact hook**

Call `handlePreCompact()` directly. Verify it returns exit code 2 (replace native compaction) and summary text in stdout.

- [ ] **Step 3: Write Flow 16 — Auto-heal (mock mode: mutation test)**

In mock mode, deliberately remove a hook from a test `settings.json`, then call `validateAndFixHooks()`. Assert the hook is restored. In live mode, this flow is read-only (verify hooks exist, don't break them).

- [ ] **Step 4: Write Flow 17 — Scrubbing**

Ingest the fixture (which contains `sk-test-FAKE-KEY-abc123def456`). Query the stored messages and assert the API key pattern is not present in any stored content.

- [ ] **Step 5: Write Flow 18 — Daemon-down resilience**

Stop the test daemon, then call each hook handler. Assert all return exit code 0 and don't throw.

- [ ] **Step 6: Write Flow 19 — Status**

Call `/status` with `{ cwd }` after all prior flows. Assert correct message, summary, and promoted counts.

- [ ] **Step 7: Run hook and resilience flow tests**

Run: `npx vitest run test/e2e/flows/hooks.test.ts test/e2e/flows/resilience.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add test/e2e/flows/hooks.test.ts test/e2e/flows/resilience.test.ts
git commit -m "test: add E2E hook and resilience flow tests (flows 14-19)"
```

---

## Task 9: E2E Flow Tests — Infrastructure (Flows 11-13)

**Files:**
- Create: `test/e2e/flows/infrastructure.test.ts` (Flows 11, 12, 13)

- [ ] **Step 1: Write Flow 11 — MCP transport**

Test all 7 MCP tools via the daemon routes:
- Daemon-backed (grep, search, expand, describe, store): Assert valid JSON response
- Local-only (stats, doctor): These are computed in-process by the MCP server, not via daemon. For E2E, call their implementations directly and assert non-empty text output with no error strings.

- [ ] **Step 2: Write Flow 12 — Doctor**

Call the doctor implementation and assert all checks pass.

- [ ] **Step 3: Write Flow 13 — Teardown**

Verify `handle.cleanup()` removes the temp dir and the project directory under `~/.lossless-claude/projects/`.

- [ ] **Step 4: Run infrastructure flow tests**

Run: `npx vitest run test/e2e/flows/infrastructure.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add test/e2e/flows/infrastructure.test.ts
git commit -m "test: add E2E infrastructure flow tests (flows 11-13)"
```

---

## Task 10: Plugin Commands

**Files:**
- Create: `.claude-plugin/commands/lcm-compact.md`
- Create: `.claude-plugin/commands/lcm-promote.md`
- Create: `.claude-plugin/commands/lcm-curate.md`
- Create: `.claude-plugin/commands/lcm-status.md`
- Modify: `.claude-plugin/commands/lcm-import.md`

- [ ] **Step 1: Create `/lcm-compact` command**

Follow the pattern of existing commands (YAML frontmatter + markdown instructions). Wraps `lcm compact --all`. Surfaces `--all`, `--verbose`, `--dry-run` params.

- [ ] **Step 2: Create `/lcm-promote` command**

Wraps `lcm promote`. Surfaces `--all`, `--verbose`, `--dry-run` params.

- [ ] **Step 3: Create `/lcm-curate` command**

Runs `lcm import` → `lcm compact --all` → `lcm promote` sequentially. Stops on first failure. Surfaces `--all`, `--verbose`, `--dry-run` params. Presents a unified summary at the end combining output from all three phases (e.g., "15 messages imported, 3 summaries created, 1 insight promoted"). Note: compact will report `promotedCount: 0` since promotion is now decoupled — the curate command must merge the promote output into the final report.

- [ ] **Step 4: Create `/lcm-status` command**

Wraps `lcm status`. Surfaces `--json` param.

- [ ] **Step 5: Update `/lcm-import` command**

Surface all CLI params: `--all`, `--verbose`, `--dry-run`.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/commands/
git commit -m "feat: add lcm-compact, lcm-promote, lcm-curate, lcm-status plugin commands"
```

---

## Task 11: `/lcm-e2e` Skill

**Files:**
- Create: `.claude-plugin/skills/lcm-e2e/SKILL.md`
- Create: `.claude-plugin/skills/lcm-e2e/checklist.md`

- [ ] **Step 1: Create SKILL.md**

Follow the pattern from the weave-e2e reference. SKILL.md should:
- Check current state (lcm version, daemon running, installed CLIs)
- Parse `$ARGUMENTS` for flow routing (import, compact, promote, curate, retrieval, hooks, doctor, cleanup, or empty for all)
- Read checklist.md and execute selected flows
- Print summary table

Allowed tools: `Bash`, `Read`

- [ ] **Step 2: Create checklist.md**

Write the 19-flow checklist with step-by-step commands and expected outputs. Each flow has:
- Goal description
- Step table (step number, command, expected output)
- Pass criteria

Include the argument routing table and the summary table template.

Include the safety section: isolated `cwd` with `e2e-test-` prefix, existing daemon (no second daemon), cleanup always runs, auto-heal is read-only.

- [ ] **Step 3: Test the skill locally**

Run `/lcm-e2e doctor` to test a subset of flows.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/skills/lcm-e2e/
git commit -m "feat: add /lcm-e2e validation skill with 19-flow checklist"
```

---

## Task 12: Full Suite Verification

- [ ] **Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: All existing 423+ tests pass, plus all new tests

- [ ] **Step 2: Run E2E tests in mock mode**

Run: `npx vitest run test/e2e/`
Expected: All 19 flows pass

- [ ] **Step 3: Run `/lcm-e2e` skill**

Invoke the skill and verify the summary table shows all flows passing.

- [ ] **Step 4: Final commit**

Review any remaining unstaged files with `git status` and stage only relevant changes explicitly. Do not use `git add -A`.
