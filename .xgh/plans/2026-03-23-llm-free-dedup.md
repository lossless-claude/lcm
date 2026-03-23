# LLM-Free Structural Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove LLM dependency from `lcm promote` deduplication, replacing it with BM25-based structural convergence that refreshes canonical entries and archives weaker duplicates.

**Architecture:** `deduplicateAndInsert()` drops its `summarize` parameter. When duplicates are found, the best BM25 match becomes canonical (confidence refreshed), weaker duplicates are archived, and the incoming entry is inserted-then-archived for recoverability. The promote route no longer needs a summarizer.

**Tech Stack:** TypeScript, SQLite FTS5, Vitest

**Spec:** `.xgh/specs/2026-03-23-llm-free-dedup-design.md`

---

### Task 1: Update `deduplicateAndInsert` tests

**Files:**
- Modify: `test/promotion/dedup.test.ts`

- [ ] **Step 1: Rewrite "merges when duplicate found" test for structural convergence**

Replace the existing test at line 48. The new behavior: canonical entry is refreshed (confidence = max), incoming is archived, no summarize call.

```typescript
it("refreshes canonical and archives incoming when duplicate found above threshold", async () => {
  const db = makeDb();
  const store = new PromotedStore(db);

  // Insert an existing entry
  store.insert({
    content: "Decided to use PostgreSQL for the database layer",
    tags: ["decision"],
    projectId: "p1",
    confidence: 0.9,
  });

  const id = await deduplicateAndInsert({
    store,
    content: "Confirmed PostgreSQL as the database choice after benchmarks",
    tags: ["decision"],
    projectId: "p1",
    sessionId: "s1",
    depth: 2,
    confidence: 0.8,
    thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
  });

  // Only the canonical entry should be in active search results
  const results = store.search("PostgreSQL database", 10);
  expect(results.length).toBe(1);
  // Canonical keeps its content (no merge)
  expect(results[0].content).toContain("Decided to use PostgreSQL");
  // Confidence is max(0.9, 0.8) = 0.9
  expect(results[0].confidence).toBe(0.9);
  // Returns canonical's ID
  expect(id).toBe(results[0].id);
});
```

- [ ] **Step 2: Rewrite "archives merged entry when confidence drops below 0.2" test**

Replace the test at line 84. With structural convergence there's no confidence decay — `Math.max` only. Replace with a test that verifies multiple duplicates are archived.

```typescript
it("archives weaker duplicates when multiple exist above threshold", async () => {
  const db = makeDb();
  const store = new PromotedStore(db);

  // Insert two existing entries
  store.insert({
    content: "Decided to use PostgreSQL for the database layer",
    tags: ["decision"],
    projectId: "p1",
    confidence: 0.7,
  });
  store.insert({
    content: "PostgreSQL was chosen for the database after evaluation",
    tags: ["decision"],
    projectId: "p1",
    confidence: 0.9,
  });

  await deduplicateAndInsert({
    store,
    content: "Confirmed PostgreSQL as the database choice",
    tags: ["decision"],
    projectId: "p1",
    sessionId: "s1",
    depth: 2,
    confidence: 0.6,
    thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 5, confidenceDecayRate: 0.1 },
  });

  // Only the canonical entry should remain in active search
  const results = store.search("PostgreSQL database", 10);
  expect(results.length).toBe(1);
  // Confidence is max of all: max(0.9, 0.7, 0.6) = 0.9
  expect(results[0].confidence).toBe(0.9);
});
```

- [ ] **Step 3: Rewrite "inserts as new when summarize fails" test**

Replace the test at line 116. With no summarize, the LLM-failure fallback is gone. Replace with a test verifying "inserts new entry when no duplicates" still passes (update to remove `summarize` param).

```typescript
it("inserts new entry when no duplicates exist", async () => {
  const db = makeDb();
  const store = new PromotedStore(db);

  await deduplicateAndInsert({
    store,
    content: "Decided to use PostgreSQL for the database",
    tags: ["decision"],
    projectId: "p1",
    sessionId: "s1",
    depth: 2,
    confidence: 0.8,
    thresholds: { dedupBm25Threshold: 15, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
  });

  const results = store.search("PostgreSQL database", 10);
  expect(results.length).toBe(1);
});
```

- [ ] **Step 4: Remove `summarize` from the existing "inserts new entry" test (line 26)**

Update the first test to drop the `mockSummarize` variable and `summarize` param.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/promotion/dedup.test.ts`
Expected: FAIL — `deduplicateAndInsert` still expects `summarize` param

- [ ] **Step 6: Commit test changes**

```bash
git add test/promotion/dedup.test.ts
git commit -m "test: update dedup tests for LLM-free structural convergence"
```

---

### Task 2: Implement structural convergence in `dedup.ts`

**Files:**
- Modify: `src/promotion/dedup.ts`

- [ ] **Step 1: Remove `summarize` from `DedupParams` and `renderTemplate` import**

Remove the `summarize: (text: string) => Promise<string>` field from `DedupParams`.
Remove the `import { renderTemplate } from "../prompts/loader.js"` line.

- [ ] **Step 2: Replace merge logic with structural convergence**

Replace the body of `deduplicateAndInsert` after the `if (duplicates.length === 0)` check:

```typescript
if (duplicates.length === 0) {
  return store.insert({ content, tags, projectId, sessionId, depth, confidence });
}

// Structural convergence: pick best BM25 match as canonical
const canonical = duplicates[0];
const refreshedConfidence = Math.max(canonical.confidence, confidence);

// Refresh canonical confidence (BM25 rank is best, so this is the strongest match)
store.update(canonical.id, { confidence: refreshedConfidence });

// Archive weaker duplicates (skip canonical at index 0)
for (let i = 1; i < duplicates.length; i++) {
  store.archive(duplicates[i].id);
}

// Insert incoming entry as archived for recoverability of complementary info
const archivedId = store.insert({ content, tags, projectId, sessionId, depth, confidence });
store.archive(archivedId);

return canonical.id;
```

- [ ] **Step 3: Remove the low-confidence archiving branch**

Delete the entire block from `// Calculate merged confidence` through `store.archive(id)`.

- [ ] **Step 4: Run dedup tests to verify they pass**

Run: `npx vitest run test/promotion/dedup.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/promotion/dedup.ts
git commit -m "feat: replace LLM merge with structural convergence in dedup"
```

---

### Task 3: Update promote route to drop summarizer dependency

**Files:**
- Modify: `src/daemon/routes/promote.ts`
- Modify: `src/daemon/server.ts`

- [ ] **Step 1: Update promote route handler signature and body**

In `src/daemon/routes/promote.ts`:
- Remove `getSummarizer` param from `createPromoteHandler`
- Remove `LcmSummarizeFn` import
- Remove `const summarize = await getSummarizer()` line
- Replace `else if (summarize)` guard with direct call:

```typescript
export function createPromoteHandler(
  config: DaemonConfig,
): RouteHandler {
```

In the loop body, replace:
```typescript
if (dry_run) {
  promoted++;
} else {
  try {
    await deduplicateAndInsert({
      store: promotedStore,
      content: summary.content,
      tags: promotionResult.tags,
      projectId: pid,
      sessionId: conversation.sessionId,
      depth: summary.depth,
      confidence: promotionResult.confidence,
      thresholds: {
        dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
        mergeMaxEntries: config.compaction.promotionThresholds.mergeMaxEntries,
        confidenceDecayRate: config.compaction.promotionThresholds.confidenceDecayRate,
      },
    });
    promoted++;
  } catch { /* non-fatal */ }
}
```

- [ ] **Step 2: Update `server.ts` to drop summarizer from promote route**

In `src/daemon/server.ts` at line 70-71, replace:
```typescript
const promoteSummarizer = () => createSummarizer(resolveEffectiveProvider(config), config);
routes.set("POST /promote", createPromoteHandler(config, promoteSummarizer));
```
with:
```typescript
routes.set("POST /promote", createPromoteHandler(config));
```

- [ ] **Step 3: Run promote route tests**

Run: `npx vitest run test/daemon/routes/promote.test.ts`
Expected: Tests fail due to signature change — need to update

- [ ] **Step 4: Update promote route tests**

In `test/daemon/routes/promote.test.ts`:
- Remove `mockSummarize` and `getSummarizer` from all test setups
- Change `createPromoteHandler(config, getSummarizer)` → `createPromoteHandler(config)`

- [ ] **Step 5: Run all promote-related tests**

Run: `npx vitest run test/daemon/routes/promote.test.ts test/promotion/dedup.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/promote.ts src/daemon/server.ts test/daemon/routes/promote.test.ts
git commit -m "feat: remove summarizer dependency from promote route"
```

---

### Task 4: Run full test suite and clean up

**Files:**
- Delete: `src/prompts/promoted-merge.yaml` (no longer referenced)

- [ ] **Step 1: Check if `promoted-merge` template is referenced anywhere else**

Run: `grep -r "promoted-merge" src/ test/`
Expected: Only `dedup.ts` (already removed). If no references remain, safe to delete.

- [ ] **Step 2: Delete the unused template**

```bash
rm src/prompts/promoted-merge.yaml
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Run e2e promote test**

Run: `npx vitest run test/e2e/flows/promote.test.ts`
Expected: PASS — e2e uses mock provider, which already returned null for summarizer

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 6: Commit cleanup**

```bash
git add -A
git commit -m "chore: remove unused promoted-merge template"
```

---

### Task 5: Verify end-to-end with live daemon

- [ ] **Step 1: Rebuild and link**

```bash
npm run build && chmod +x dist/bin/lcm.js && npm link
```

- [ ] **Step 2: Restart daemon**

```bash
kill $(lsof -ti :3737) 2>/dev/null; sleep 1; lcm daemon start --detach
```

- [ ] **Step 3: Run promote**

```bash
lcm promote --verbose
```

Expected: Completes instantly (no LLM calls), reports processed/promoted counts.

- [ ] **Step 4: Verify no timeout errors**

If `--verbose` isn't supported, just run `lcm promote` and confirm exit code 0 with output.
