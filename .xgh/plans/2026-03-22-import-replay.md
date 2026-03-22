# Import Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lcm import --replay` which imports sessions in chronological order and compacts each one immediately, threading the resulting summary content as context into the next compaction — producing a temporal DAG instead of isolated per-conversation compression trees.

**Architecture:** The replay loop lives in `importSessions()`. It sorts sessions by file mtime, ingests each via `/ingest`, then immediately calls `/compact` with a new `previous_summary` field. The compact route fetches the actual summary content from the store (via `createdSummaryId` → `summaryStore.getSummary()`) and returns it as `latestSummaryContent`. This is passed as `previousSummaryContent` to `CompactionEngine.compact()` → `compactFullSweep()` → first `leafPass()`.

**Tech Stack:** TypeScript, `node:fs` (`statSync` for mtime, `utimesSync` in tests), existing daemon HTTP endpoints `/ingest` and `/compact`, `CompactionEngine` in `src/compaction.ts`, `SummaryStore` in `src/store/summary-store.ts`.

---

## File Map

| File | Change |
|------|--------|
| `src/import.ts` | Add `replay` option; sort sessions by mtime; thread compact calls using `latestSummaryContent` |
| `src/compaction.ts` | Add `previousSummaryContent?` to `compact()` and `compactFullSweep()` inputs; seed first leaf pass |
| `src/daemon/routes/compact.ts` | Accept `previous_summary` in POST body; pass to engine; fetch actual summary content and return as `latestSummaryContent` |
| `bin/lcm.ts` | Parse `--replay` flag; pass to `importSessions()` |
| `test/compaction.test.ts` | **Create new file.** Test that `previousSummaryContent` seeds the first leaf pass |
| `test/import.test.ts` | Tests for mtime sort + replay compact threading |
| `test/daemon/routes/compact.test.ts` | Test `previous_summary` → `previousSummaryContent` flow and `latestSummaryContent` response |

---

## Task 1: Sort sessions by mtime in `findSessionFiles`

**Files:**
- Modify: `src/import.ts`
- Test: `test/import.test.ts`

Sessions from `readdirSync` arrive in arbitrary FS order. The replay loop requires chronological ordering — sort by mtime ascending so the oldest session compacts first.

- [ ] **Step 1: Write the failing test**

Add to `describe("findSessionFiles")` in `test/import.test.ts`. Also add `utimesSync` to the fs imports at the top of the file:

```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
```

Add the test:

```ts
it("returns files sorted by mtime ascending", () => {
  const dir = makeTmpDir();
  const older = join(dir, "session-old.jsonl");
  const newer = join(dir, "session-new.jsonl");
  writeFileSync(newer, "");  // write newer first so FS order ≠ mtime order
  writeFileSync(older, "");
  const oldTime = new Date(Date.now() - 10_000);
  utimesSync(older, oldTime, oldTime);

  const result = findSessionFiles(dir);
  expect(result.map(f => f.sessionId)).toEqual(["session-old", "session-new"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/import.test.ts 2>&1 | tail -20
```

Expected: FAIL — `findSessionFiles` returns unsorted; `mtime` field doesn't exist.

- [ ] **Step 3: Add mtime to session file records and sort**

In `src/import.ts`, add `statSync` to the fs import:

```ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
```

Update the return type signature:

```ts
export function findSessionFiles(projectDir: string): { path: string; sessionId: string; mtime: number }[] {
  const files: { path: string; sessionId: string; mtime: number }[] = [];
```

For every `files.push(...)` call in the function body (there are two: top-level `.jsonl` files and subagent files), add `mtime`:

```ts
// top-level:
files.push({
  path: join(projectDir, entry.name),
  sessionId: basename(entry.name, '.jsonl'),
  mtime: statSync(join(projectDir, entry.name)).mtimeMs,
});

// subagents:
files.push({
  path: join(subagentsDir, sub.name),
  sessionId: basename(sub.name, '.jsonl'),
  mtime: statSync(join(subagentsDir, sub.name)).mtimeMs,
});
```

Sort before returning:

```ts
  return files.sort((a, b) => a.mtime - b.mtime);
}
```

The existing callers in `importSessions` destructure `{ path, sessionId }` — adding `mtime` is backward-compatible.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/import.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/import.ts test/import.test.ts
git commit -m "feat: sort findSessionFiles by mtime ascending for replay ordering"
```

---

## Task 2: Thread `previousSummaryContent` through the compact engine

**Files:**
- Modify: `src/compaction.ts` (export `CompactionSummarizeFn` + add field to `compact()`/`compactFullSweep()`)
- Create: `test/compaction.test.ts` — this file does not exist, create it from scratch

`compact()` delegates to `compactFullSweep()`. The first leaf pass in `compactFullSweep()` starts with `let previousSummaryContent: string | undefined` — currently always `undefined`. We need the caller to be able to seed this from a prior session's summary.

**Key facts about `CompactionSummarizeFn` before writing the test:**
- It is currently a `type` (not `export type`) in `src/compaction.ts` — the test cannot import it until we export it.
- Its signature is: `(text: string, aggressive?: boolean, options?: CompactionSummarizeOptions) => Promise<string>` — returns `Promise<string>` (plain text), NOT `Promise<{content, level}>`.
- The `options` parameter is the **third** positional argument (after `aggressive`).

- [ ] **Step 1: Export `CompactionSummarizeFn` in `src/compaction.ts`**

Find this line in `src/compaction.ts`:

```ts
type CompactionSummarizeFn = (
```

Change it to:

```ts
export type CompactionSummarizeFn = (
```

This makes it importable in the test.

- [ ] **Step 2: Create `test/compaction.test.ts` with the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { CompactionEngine, type CompactionSummarizeFn } from "../src/compaction.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";

function makeMinimalStores(): { conversationStore: ConversationStore; summaryStore: SummaryStore } {
  const summaryStore = {
    getContextTokenCount: vi.fn().mockResolvedValue(50_000),
    getContextItems: vi.fn().mockResolvedValue([
      { ordinal: 0, itemType: "message", messageId: "msg-1", summaryId: null, tokenCount: 50_000 },
    ]),
    insertSummary: vi.fn().mockResolvedValue(undefined),
    linkSummaryToMessages: vi.fn().mockResolvedValue(undefined),
    replaceContextRangeWithSummary: vi.fn().mockResolvedValue(undefined),
    getMessageContent: vi.fn().mockResolvedValue([{
      messageId: "msg-1", role: "user", content: "hello", tokenCount: 50_000,
      createdAt: new Date(), fileIds: [],
    }]),
  } as unknown as SummaryStore;

  const conversationStore = {
    getConversation: vi.fn().mockResolvedValue({ conversationId: 1, sessionId: "sess-1" }),
    getMaxSeq: vi.fn().mockResolvedValue(0),
    createMessage: vi.fn().mockResolvedValue({ messageId: "evt-1" }),
    createMessageParts: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn().mockImplementation((fn: () => Promise<void>) => fn()),
  } as unknown as ConversationStore;

  return { conversationStore, summaryStore };
}

describe("CompactionEngine.compact — previousSummaryContent seeding", () => {
  it("passes previousSummaryContent to summarize on the first leaf call", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();

    const summarizeCalls: { previousSummary?: string }[] = [];
    // Correct signature: (text, aggressive?, options?) => Promise<string>
    const summarize: CompactionSummarizeFn = vi.fn().mockImplementation(
      async (_text: string, _aggressive?: boolean, options?: { previousSummary?: string }) => {
        summarizeCalls.push({ previousSummary: options?.previousSummary });
        return "summary content";  // returns plain string, not {content, level}
      }
    );

    const engine = new CompactionEngine(conversationStore, summaryStore, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      freshTailTokens: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      previousSummaryContent: "prior context",
    });

    expect(summarizeCalls.length).toBeGreaterThan(0);
    expect(summarizeCalls[0].previousSummary).toBe("prior context");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run test/compaction.test.ts 2>&1 | tail -20
```

Expected: TypeScript error — `compact()` does not accept `previousSummaryContent`.

- [ ] **Step 4: Update `compact()` and `compactFullSweep()` signatures in `src/compaction.ts`**

Add `previousSummaryContent?` to the `compact()` input object:

```ts
async compact(input: {
  conversationId: number;
  tokenBudget: number;
  summarize: CompactionSummarizeFn;
  force?: boolean;
  hardTrigger?: boolean;
  /** Seed context from a prior session's final summary (used in replay import). */
  previousSummaryContent?: string;
}): Promise<CompactionResult> {
  return this.compactFullSweep(input);
}
```

Add the same field to `compactFullSweep()`'s input type. Then in the body of `compactFullSweep()`, find this line:

```ts
let previousSummaryContent: string | undefined;
```

Replace it with:

```ts
// Seed from caller (cross-session replay) or start fresh
let previousSummaryContent: string | undefined = input.previousSummaryContent;
```

Do NOT add `previousSummaryContent` to the destructure at the top of `compactFullSweep()` — assign it directly via `input.previousSummaryContent` to avoid a shadowing conflict with the `let` declaration.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/compaction.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 6: Run full test suite to check no regressions**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/compaction.ts test/compaction.test.ts
git commit -m "feat: export CompactionSummarizeFn; thread previousSummaryContent seed into compactFullSweep for cross-session context"
```

---

## Task 3: Return `latestSummaryContent` from the `/compact` route and accept `previous_summary`

**Files:**
- Modify: `src/daemon/routes/compact.ts`
- Test: `test/daemon/routes/compact.test.ts`

**Important context:**
- `CompactionResult` has `createdSummaryId?: string` (the summary ID), not the summary text.
- The route currently returns `{ summary: summaryMsg }` where `summaryMsg` is a human-readable stats string like `"✓ Compacted: 45K → 12K tokens..."` — NOT the actual summary content.
- We need to fetch the actual content from `summaryStore.getSummary(createdSummaryId)` and add it to the response as `latestSummaryContent`.
- The import loop will use `latestSummaryContent`, not `summary`.

- [ ] **Step 1: Write the failing tests**

In `test/daemon/routes/compact.test.ts`, add two tests using the existing test patterns in that file:

**Test A:** POST with `previous_summary: "prior context"` → assert `CompactionEngine.compact()` is called with `previousSummaryContent: "prior context"`.

**Test B:** When compact succeeds and `createdSummaryId` is set → assert response includes `latestSummaryContent` equal to the fetched summary's content.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/daemon/routes/compact.test.ts 2>&1 | tail -20
```

Expected: FAIL

- [ ] **Step 3: Update the compact route**

In `src/daemon/routes/compact.ts`, make three changes:

**Change 1 — Extract `previous_summary` from body:**

```ts
const { session_id, cwd, transcript_path, skip_ingest, client, previous_summary } = input;
```

**Change 2 — Forward to `engine.compact()`:**

Find the `engine.compact({...})` call and add:

```ts
const compactResult = await engine.compact({
  conversationId: conversation.conversationId,
  tokenBudget: config.compaction.contextBudgetTokens,
  summarize,
  force: true,
  hardTrigger: true,
  previousSummaryContent: previous_summary,  // ← new
});
```

**Change 3 — Fetch actual summary content and include in response:**

After the `engine.compact()` call, before the final `sendJson(res, 200, ...)`, fetch the summary content:

```ts
// Fetch the actual summary text so callers can thread it forward (e.g. replay import).
let latestSummaryContent: string | undefined;
if (compactResult.createdSummaryId) {
  const summaryRecord = await summaryStore.getSummary(compactResult.createdSummaryId);
  latestSummaryContent = summaryRecord?.content;
}
```

Include `latestSummaryContent` in the success response alongside the existing `summary` stats string:

```ts
sendJson(res, 200, {
  summary: summaryMsg,
  latestSummaryContent,   // ← new: actual LLM summary text, undefined if no compaction occurred
  skipped: false,
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/daemon/routes/compact.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/compact.ts test/daemon/routes/compact.test.ts
git commit -m "feat: return latestSummaryContent from /compact route; accept previous_summary for context chaining"
```

---

## Task 4: Implement the replay loop in `importSessions`

**Files:**
- Modify: `src/import.ts`
- Test: `test/import.test.ts`

When `replay: true`, after each ingest (fresh or already-ingested), call `/compact` and use `latestSummaryContent` to thread context forward.

**Key design decisions:**
- Fire compact for ALL sessions in replay mode (not just freshly ingested ones), so re-runs are idempotent and the chain doesn't break mid-history. The compact endpoint is safe to call repeatedly — it skips if already compacted.
- `previousSummaryContent` resets per project (each project gets its own temporal chain).
- Compact failure is non-fatal: log and continue (import succeeded; the chain just loses its link at that point).

- [ ] **Step 1: Write the failing test**

The test fixture must match `importSessions`'s directory layout: it expects `_claudeProjectsDir/{cwdHash}/{sessionId}.jsonl`. Concretely:

```ts
it("replay mode calls compact after each session in mtime order, threading latestSummaryContent", async () => {
  const claudeProjectsDir = makeTmpDir();
  const cwd = "/test/project";
  const hash = cwdToProjectHash(cwd);  // → "-test-project"
  const projDir = join(claudeProjectsDir, hash);
  mkdirSync(projDir, { recursive: true });

  const f1 = join(projDir, "session-1.jsonl");
  const f2 = join(projDir, "session-2.jsonl");
  writeFileSync(f2, "");  // write f2 first so FS order ≠ mtime order
  writeFileSync(f1, "");
  const oldTime = new Date(Date.now() - 10_000);
  utimesSync(f1, oldTime, oldTime);  // f1 is older

  const compactBodies: { session_id: string; previous_summary?: string }[] = [];
  const mockClient = {
    post: vi.fn().mockImplementation(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "stats", latestSummaryContent: `summary-of-${body.session_id}` };
      }
    }),
  } as unknown as DaemonClient;

  await importSessions(mockClient, {
    replay: true,
    verbose: false,
    cwd,
    _claudeProjectsDir: claudeProjectsDir,
  });

  // Both sessions were compacted, in mtime order
  expect(compactBodies).toHaveLength(2);
  expect(compactBodies[0].session_id).toBe("session-1");
  expect(compactBodies[0].previous_summary).toBeUndefined();
  expect(compactBodies[1].session_id).toBe("session-2");
  expect(compactBodies[1].previous_summary).toBe("summary-of-session-1");
});
```

`cwdToProjectHash` is already imported in `test/import.test.ts` — no import change needed.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/import.test.ts 2>&1 | tail -20
```

Expected: FAIL — `replay` option doesn't exist.

- [ ] **Step 3: Implement replay in `importSessions`**

Add `replay?: boolean` to `ImportOptions`:

```ts
interface ImportOptions {
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  replay?: boolean;                   // ← new
  _claudeProjectsDir?: string;
  _lcmDir?: string;
}
```

In the session loop, track `previousSummary` per project and call compact after every session (not just freshly ingested ones):

```ts
for (const { dir, cwd } of projectDirs) {
  const sessionFiles = findSessionFiles(dir);
  let previousSummary: string | undefined;  // resets per project

  for (const { path, sessionId } of sessionFiles) {
    if (options.dryRun) {
      if (options.verbose) console.log(`  [dry-run] ${sessionId}`);
      result.imported++;
      continue;
    }

    try {
      const res = await client.post<{ ingested: number; totalTokens: number }>("/ingest", {
        session_id: sessionId,
        cwd,
        transcript_path: path,
      });

      if (res.ingested === 0 && res.totalTokens === 0) {
        result.skippedEmpty++;
        if (options.verbose) console.log(`  ∅ ${sessionId}: empty or already ingested`);
      } else {
        result.imported++;
        result.totalMessages += res.ingested;
        if (options.verbose) console.log(`  ✓ ${sessionId}: ${res.ingested} messages`);
      }

      // Replay: compact immediately after every session (even already-ingested ones)
      // so that re-runs are idempotent and the temporal chain stays intact.
      if (options.replay) {
        try {
          const compactRes = await client.post<{
            summary?: string;
            latestSummaryContent?: string;
            skipped?: boolean;
          }>("/compact", {
            session_id: sessionId,
            cwd,
            skip_ingest: true,
            client: "claude",
            ...(previousSummary !== undefined ? { previous_summary: previousSummary } : {}),
          });
          if (compactRes.latestSummaryContent) {
            previousSummary = compactRes.latestSummaryContent;
          }
          if (options.verbose) {
            const ctx = previousSummary ? " (with prior context)" : "";
            console.log(`  🧠 ${sessionId}: compacted${ctx}`);
          }
        } catch (err) {
          // Non-fatal: import succeeded; compact failure breaks the chain at this link.
          if (options.verbose) {
            console.log(`  ⚠ ${sessionId}: compact failed — ${err instanceof Error ? err.message : "unknown"}`);
          }
        }
      }
    } catch (err) {
      result.failed++;
      if (options.verbose) {
        console.log(`  ✗ ${sessionId}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/import.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/import.ts test/import.test.ts
git commit -m "feat: implement replay loop in importSessions — compact-per-session with threaded latestSummaryContent"
```

---

## Task 5: Wire `--replay` flag in `bin/lcm.ts`

**Files:**
- Modify: `bin/lcm.ts`

No new tests — this is pure CLI plumbing covered by unit tests in Tasks 1–4.

- [ ] **Step 1: Add `--replay` to the import case**

In `bin/lcm.ts`, find `case "import":` (line ~339). Add the flag and pass it through:

```ts
case "import": {
  const all = argv.includes("--all");
  const verbose = argv.includes("--verbose");
  const dryRun = argv.includes("--dry-run");
  const replay = argv.includes("--replay");        // ← add

  // ... existing daemon/client setup unchanged ...

  const result = await importSessions(client, { all, verbose, dryRun, replay });  // ← add replay

  if (dryRun) console.log("  [dry-run] No changes written.\n");
  if (replay) console.log("  [replay] Sessions compacted sequentially with threaded context.\n");  // ← add
  console.log(`  ${result.imported} sessions imported (${result.totalMessages} messages)`);
  // ... rest unchanged
```

- [ ] **Step 2: Build and smoke-test**

```bash
npm run build 2>&1 | tail -20
```

Expected: zero TypeScript errors.

```bash
node dist/bin/lcm.js import --dry-run --replay 2>&1 | head -10
```

Expected: dry-run output, no crash.

- [ ] **Step 3: Commit**

```bash
git add bin/lcm.ts
git commit -m "feat: add --replay flag to lcm import CLI"
```

---

## Task 6: Full test suite + docs

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: Find the lcm-import skill file and add `--replay` docs**

```bash
find /Users/pedro/Developer/lossless-claude -name "lcm-import*" | grep -v node_modules | head -5
```

Open whichever `.md` file is returned. In the **Options** section, add:

```markdown
- `--replay` — Import and compact each session in mtime order, threading each
  session's final summary content as context into the next compaction. Produces
  a temporal DAG. Ideal for first-time historical imports. Slower than plain import
  (one LLM call per session).
```

- [ ] **Step 3: Commit**

```bash
git add $(find . -name "lcm-import*" -not -path "*/node_modules/*")
git commit -m "docs: document --replay flag in lcm-import skill"
```
