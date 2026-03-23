# Redaction Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Security section to `lcm stats` showing how many secrets were scrubbed, broken down by built-in / global / project patterns.

**Architecture:** `ScrubEngine.scrub()` returns `{ text, counts }` with per-category hit counts tagged at construction time. Ingest and compact routes write one `message_redactions` row per `(message_id, category)` pair after storing messages. `collectStats()` aggregates across all project DBs; `printStats()` renders a Security section when total > 0. A new `GET /stats` daemon route exposes the same data as JSON.

**Tech Stack:** TypeScript, Node.js built-in `node:sqlite` (`DatabaseSync`), Vitest

**Spec:** `.xgh/specs/2026-03-22-redaction-stats-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/scrub.ts` | Modify | Add `PatternEntry`, `RedactionCounts`, `ScrubResult`; change `scrub()` return type; tag patterns by category at construction |
| `src/db/migration.ts` | Modify | Add `message_redactions` table after `promoted` block |
| `src/daemon/routes/ingest.ts` | Modify | Use `.text`; write per-message redaction counts after `createMessagesBulk` |
| `src/daemon/routes/compact.ts` | Modify | Same as ingest — only the ingest-new-messages block needs counting |
| `src/compaction.ts` | Modify | Use `.text` only (line 972) — LLM-only scrub, no counting |
| `src/sensitive.ts` | Modify | Use `.text` only (line 230) — preview command, no counting |
| `src/stats.ts` | Modify | Add `redactionCounts` to `OverallStats`; read from DB in `queryProjectStats`; sum in `collectStats`; render Security section in `printStats` |
| `src/daemon/routes/stats.ts` | Create | `GET /stats` route handler — calls `collectStats()`, returns JSON |
| `test/daemon/routes/stats.test.ts` | Create | Integration test for `GET /stats` route |
| `src/daemon/server.ts` | Modify | Import and register `GET /stats` |
| `test/scrub.test.ts` | Modify | Update all `engine.scrub(...)` assertions to use `.text` / `.counts` |
| `test/migration.test.ts` | Modify | Add idempotency test for `message_redactions` table |
| `test/daemon/routes/ingest.test.ts` | Modify | Add test that redaction counts are written to the DB |
| `test/stats.test.ts` | Modify | Add test that Security section renders when `redactionCounts > 0` |

---

## Task 1: Update `ScrubEngine` — return type + per-category counting

**Files:**
- Modify: `src/scrub.ts`
- Modify: `test/scrub.test.ts`

### Context

`ScrubEngine` lives at `src/scrub.ts`. Its constructor currently merges all three pattern groups into two lists (`spanningPatterns`, `tokenPatterns`) typed as `Array<{ source: string; regex: RegExp }>`, losing origin info. The `scrub()` method at line 67 returns `string`.

We need to:
1. Add a `category` field to each stored pattern entry so we can count hits by origin.
2. Change `scrub()` to return `{ text: string; counts: RedactionCounts }`.
3. Export `RedactionCounts` and `ScrubResult` for use by callers.

- [ ] **Step 1.1 — Write the failing tests**

The existing `test/scrub.test.ts` calls `engine.scrub(...)` and asserts on a string return value. After the change, `scrub()` returns `ScrubResult`, so those assertions need to use `.text`. Additionally, add a new `describe` block for counting behaviour.

**Two changes to `test/scrub.test.ts`:**

**a) Update existing assertions** — change every `engine.scrub(...)` call that is not already using `.text` to add `.text`. Specifically:

```typescript
// Before:
expect(engine.scrub("key=sk-abcdefghijklmnopqrstu")).toContain("[REDACTED]");
// After:
expect(engine.scrub("key=sk-abcdefghijklmnopqrstu").text).toContain("[REDACTED]");
```

Apply the `.text` suffix to every similar assertion in the file (there are ~10 of them). The one that currently asserts `toBe(text)` for clean input also needs updating:

```typescript
// Before:
expect(engine.scrub(text)).toBe(text);
// After:
expect(engine.scrub(text).text).toBe(text);
```

**b) Append a new `describe` block at the end of the file:**

```typescript
describe("ScrubEngine.scrub — per-category counts", () => {
  it("returns an object with text and counts", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrub("hello world");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("counts");
  });

  it("counts built-in pattern hits in builtIn, not global/project", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrub("key=sk-abcdefghijklmnopqrstu");
    expect(result.counts.builtIn).toBeGreaterThan(0);
    expect(result.counts.global).toBe(0);
    expect(result.counts.project).toBe(0);
  });

  it("returns zero counts for clean input", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrub("nothing secret here");
    expect(result.counts.builtIn).toBe(0);
    expect(result.counts.global).toBe(0);
    expect(result.counts.project).toBe(0);
  });

  it("counts global pattern hits in global, not builtIn/project", () => {
    const engine = new ScrubEngine(["MY_TOKEN_[A-Z0-9]+"], []);
    const result = engine.scrub("token=MY_TOKEN_ABC123");
    expect(result.counts.global).toBeGreaterThan(0);
    expect(result.counts.builtIn).toBe(0);
    expect(result.counts.project).toBe(0);
  });

  it("counts project pattern hits in project, not builtIn/global", () => {
    const engine = new ScrubEngine([], ["PROJ_SECRET_[A-Z0-9]+"]);
    const result = engine.scrub("secret=PROJ_SECRET_XYZ");
    expect(result.counts.project).toBeGreaterThan(0);
    expect(result.counts.builtIn).toBe(0);
    expect(result.counts.global).toBe(0);
  });
});
```

- [ ] **Step 1.2 — Run tests to confirm they fail**

```bash
npm test -- --run test/scrub.test.ts
```

Expected: tests for `.text`, `.counts` fail because `scrub()` still returns a string.

- [ ] **Step 1.3 — Implement the changes in `src/scrub.ts`**

Replace the top of `src/scrub.ts` (everything from `export class ScrubEngine` through the closing `}` of the constructor) with:

```typescript
export interface RedactionCounts {
  builtIn: number;
  global: number;
  project: number;
}

export interface ScrubResult {
  text: string;
  counts: RedactionCounts;
}

type PatternCategory = "builtIn" | "global" | "project";

type PatternEntry = {
  source: string;
  regex: RegExp;
  category: PatternCategory;
};

export class ScrubEngine {
  private readonly spanningPatterns: PatternEntry[] = [];
  private readonly tokenPatterns: PatternEntry[] = [];
  readonly invalidPatterns: string[] = [];

  constructor(globalPatterns: string[], projectPatterns: string[]) {
    const grouped: Array<{ source: string; category: PatternCategory }> = [
      ...BUILT_IN_PATTERNS.map((source) => ({ source, category: "builtIn" as const })),
      ...globalPatterns.map((source) => ({ source, category: "global" as const })),
      ...projectPatterns.map((source) => ({ source, category: "project" as const })),
    ];
    for (const { source, category } of grouped) {
      try {
        const regex = new RegExp(source, "g");
        if (isSpanningPattern(source)) {
          this.spanningPatterns.push({ source, regex, category });
        } else {
          this.tokenPatterns.push({ source, regex, category });
        }
      } catch {
        this.invalidPatterns.push(source);
      }
    }
  }
```

Then replace the `scrub(text: string): string {` signature and its body up to (but not including) `loadProjectPatterns`) with:

```typescript
  scrub(text: string): ScrubResult {
    const counts: RedactionCounts = { builtIn: 0, global: 0, project: 0 };

    // Step 1: collect ranges from spanning patterns applied to full text
    const ranges: Array<[number, number]> = [];
    for (const { regex, category } of this.spanningPatterns) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        counts[category]++;
        ranges.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) regex.lastIndex++;
      }
    }

    // Step 2: apply token patterns per whitespace-separated segment
    const segments = text.split(/(\s+)/);
    const tokenRanges: Array<[number, number]> = [];
    let offset = 0;
    for (const seg of segments) {
      if (!/^\s+$/.test(seg) && this.tokenPatterns.length > 0) {
        for (const { regex, category } of this.tokenPatterns) {
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(seg)) !== null) {
            counts[category]++;
            tokenRanges.push([offset + m.index, offset + m.index + m[0].length]);
            if (m[0].length === 0) regex.lastIndex++;
          }
        }
      }
      offset += seg.length;
    }

    const allRanges = [...ranges, ...tokenRanges];
    if (allRanges.length === 0) return { text, counts };

    // Sort and merge overlapping ranges
    allRanges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    let [curStart, curEnd] = allRanges[0];
    for (let i = 1; i < allRanges.length; i++) {
      const [s, e] = allRanges[i];
      if (s <= curEnd) {
        curEnd = Math.max(curEnd, e);
      } else {
        merged.push([curStart, curEnd]);
        curStart = s;
        curEnd = e;
      }
    }
    merged.push([curStart, curEnd]);

    // Build result
    let result = "";
    let pos = 0;
    for (const [s, e] of merged) {
      result += text.slice(pos, s) + "[REDACTED]";
      pos = e;
    }
    result += text.slice(pos);
    return { text: result, counts };
  }
```

- [ ] **Step 1.4 — Run tests to confirm they pass**

```bash
npm test -- --run test/scrub.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.5 — Commit**

```bash
git add src/scrub.ts test/scrub.test.ts
git commit -m "feat(scrub): return ScrubResult with per-category redaction counts"
```

---

## Task 2: Add `message_redactions` migration

**Files:**
- Modify: `src/db/migration.ts`
- Modify: `test/migration.test.ts`

### Context

`runLcmMigrations` in `src/db/migration.ts` is one large function that runs all DDL. The `promoted` table block ends around line 524 (just before `PRAGMA table_info(promoted)` checks for `archived_at`). Insert the new table DDL there.

The idempotency test pattern lives at `test/migration.test.ts:266` — mirror it for `message_redactions`.

- [ ] **Step 2.1 — Write the failing test**

In `test/migration.test.ts`, add a new `describe` block at the end of the file:

```typescript
describe("message_redactions table", () => {
  it("creates the table via migration", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-redactions-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_redactions'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    db.close();
  });

  it("is idempotent — running migration twice does not error", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-redactions-idem-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);
    runLcmMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_redactions'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    db.close();
  });

  it("enforces ON DELETE CASCADE from messages", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-redactions-cascade-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    runLcmMigrations(db);

    // Insert a conversation + message + redaction row
    db.prepare(
      "INSERT INTO conversations (session_id, created_at, updated_at) VALUES ('s1', datetime('now'), datetime('now'))"
    ).run();
    const convRow = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };

    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, 0, 'user', 'x', 1)"
    ).run(convRow.id);
    const msgRow = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };

    db.prepare(
      "INSERT INTO message_redactions (message_id, category, count) VALUES (?, 'builtIn', 3)"
    ).run(msgRow.id);

    // Deleting the message should cascade-delete the redaction
    db.prepare("DELETE FROM messages WHERE message_id = ?").run(msgRow.id);

    const redactions = db
      .prepare("SELECT * FROM message_redactions WHERE message_id = ?")
      .all(msgRow.id) as unknown[];
    expect(redactions).toHaveLength(0);

    db.close();
  });
});
```

- [ ] **Step 2.2 — Run tests to confirm they fail**

```bash
npm test -- --run test/migration.test.ts
```

Expected: the three new tests fail because `message_redactions` table does not exist.

- [ ] **Step 2.3 — Add the DDL to `runLcmMigrations`**

In `src/db/migration.ts`, find the block:

```typescript
  // Add archived_at to promoted if not present
  const promotedColumns = db.prepare(`PRAGMA table_info(promoted)`).all() as Array<{ name?: string }>;
```

Insert immediately before that line:

```typescript
  // Per-message redaction counts (no CHECK constraint on category — avoids table-rebuild on new categories)
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_redactions (
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
      category   TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, category)
    );
  `);

```

- [ ] **Step 2.4 — Run tests to confirm they pass**

```bash
npm test -- --run test/migration.test.ts
```

Expected: all migration tests pass (including the 3 new ones).

- [ ] **Step 2.5 — Commit**

```bash
git add src/db/migration.ts test/migration.test.ts
git commit -m "feat(db): add message_redactions table with ON DELETE CASCADE"
```

---

## Task 3: Update ingest route — use `.text`, write counts

**Files:**
- Modify: `src/daemon/routes/ingest.ts`
- Modify: `test/daemon/routes/ingest.test.ts`

### Context

`createIngestHandler` is in `src/daemon/routes/ingest.ts`. The key block (around line 77-90) maps new messages to inputs using `scrubber.scrub(m.content)` and then calls `createMessagesBulk`. We need to:
1. Capture each `ScrubResult` before building inputs.
2. Use `.text` for the `content` field.
3. After `createMessagesBulk`, write one `INSERT INTO message_redactions` row per `(message_id, category)` pair where `count > 0`.

The `DatabaseSync` handle (`db`) is already open in scope.

- [ ] **Step 3.1 — Write the failing test**

In `test/daemon/routes/ingest.test.ts`, add a new test after the existing scrub test:

```typescript
it("writes redaction counts to message_redactions when secrets are found", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-ingest-counts-"));
  tempDirs.push(tempDir);

  daemon = await createDaemon(
    loadDaemonConfig("/nonexistent", {
      daemon: { port: 0 },
      security: { sensitivePatterns: [] },
    }),
  );

  const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "redaction-count-test",
      cwd: tempDir,
      messages: [
        { role: "user", content: "my key is sk-abcdefghijklmnopqrstu", tokenCount: 10 },
        { role: "assistant", content: "noted", tokenCount: 2 },
      ],
    }),
  });

  expect(res.status).toBe(200);

  // Verify redaction counts were written
  // `projectDbPath` is already imported at the top of this test file
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = projectDbPath(tempDir);

  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT category, SUM(count) as total FROM message_redactions GROUP BY category")
    .all() as Array<{ category: string; total: number }>;
  db.close();

  const builtInRow = rows.find((r) => r.category === "builtIn");
  expect(builtInRow).toBeDefined();
  expect(builtInRow!.total).toBeGreaterThan(0);
});
```

> **Note:** If the existing ingest tests use a different helper to locate the DB (e.g., `projectDbPath`), use the same pattern here instead of reconstructing the path manually.

- [ ] **Step 3.2 — Run the test to confirm it fails**

```bash
npm test -- --run test/daemon/routes/ingest.test.ts
```

Expected: new test fails — no rows in `message_redactions`.

- [ ] **Step 3.3 — Update the ingest route**

In `src/daemon/routes/ingest.ts`, replace the message-mapping + bulk-insert block (the section that maps `newMessages` to `inputs` and calls `createMessagesBulk`) with:

```typescript
      // Scrub each message and capture per-message counts
      const scrubResults = newMessages.map((m) => scrubber.scrub(m.content));

      const inputs = newMessages.map((m, i) => ({
        conversationId: conversation.conversationId,
        seq: storedCount + i,
        role: m.role as "user" | "assistant" | "system" | "tool",
        content: scrubResults[i].text,
        tokenCount: m.tokenCount,
      }));
      const records = await conversationStore.createMessagesBulk(inputs);

      // Write per-message redaction counts
      if (scrubResults.some((r) => r.counts.builtIn + r.counts.global + r.counts.project > 0)) {
        const insertRedaction = db.prepare(`
          INSERT INTO message_redactions (message_id, category, count)
          VALUES (?, ?, ?)
          ON CONFLICT(message_id, category) DO UPDATE SET count = excluded.count
        `);
        for (let i = 0; i < records.length; i++) {
          const { builtIn, global: globalCount, project } = scrubResults[i].counts;
          if (builtIn > 0) insertRedaction.run(records[i].messageId, "builtIn", builtIn);
          if (globalCount > 0) insertRedaction.run(records[i].messageId, "global", globalCount);
          if (project > 0) insertRedaction.run(records[i].messageId, "project", project);
        }
      }
```

- [ ] **Step 3.4 — Run all tests to confirm they pass**

```bash
npm test -- --run test/daemon/routes/ingest.test.ts
```

Expected: all tests pass, including the new redaction-counts test.

- [ ] **Step 3.5 — Commit**

```bash
git add src/daemon/routes/ingest.ts test/daemon/routes/ingest.test.ts
git commit -m "feat(ingest): write per-message redaction counts to message_redactions"
```

---

## Task 4: Update compact route — use `.text`, write counts

**Files:**
- Modify: `src/daemon/routes/compact.ts`

### Context

The compact route's ingest-new-messages block is at lines ~172-187 of `src/daemon/routes/compact.ts`. It mirrors the ingest route pattern exactly — same fix applies.

- [ ] **Step 4.1 — Update the compact route**

In `src/daemon/routes/compact.ts`, replace the message-mapping + bulk-insert block inside the `if (!skip_ingest && ...)` guard:

```typescript
      const scrubResults = newMessages.map((m) => scrubber.scrub(m.content));

      const inputs = newMessages.map((m, i) => ({
        conversationId: conversation.conversationId,
        seq: storedCount + i,
        role: m.role as "user" | "assistant" | "system",
        content: scrubResults[i].text,
        tokenCount: m.tokenCount,
      }));
      const records = await conversationStore.createMessagesBulk(inputs);
      await summaryStore.appendContextMessages(
        conversation.conversationId,
        records.map((r) => r.messageId),
      );

      // Write per-message redaction counts
      if (scrubResults.some((r) => r.counts.builtIn + r.counts.global + r.counts.project > 0)) {
        const insertRedaction = db.prepare(`
          INSERT INTO message_redactions (message_id, category, count)
          VALUES (?, ?, ?)
          ON CONFLICT(message_id, category) DO UPDATE SET count = excluded.count
        `);
        for (let i = 0; i < records.length; i++) {
          const { builtIn, global: globalCount, project } = scrubResults[i].counts;
          if (builtIn > 0) insertRedaction.run(records[i].messageId, "builtIn", builtIn);
          if (globalCount > 0) insertRedaction.run(records[i].messageId, "global", globalCount);
          if (project > 0) insertRedaction.run(records[i].messageId, "project", project);
        }
      }
```

> **Note:** The `summaryStore.appendContextMessages` call that follows the original `createMessagesBulk` call must be preserved — move it into the new block as shown above.

- [ ] **Step 4.2 — Run the full test suite**

```bash
npm test
```

Expected: all tests pass. No compact-specific test covers this path currently, so this is a compile/runtime check.

- [ ] **Step 4.3 — Commit**

```bash
git add src/daemon/routes/compact.ts
git commit -m "feat(compact): write per-message redaction counts to message_redactions"
```

---

## Task 5: Update non-counting call sites

**Files:**
- Modify: `src/compaction.ts` (line 972)
- Modify: `src/sensitive.ts` (line 230)

### Context

Two call sites use `scrub()` but must NOT write counts:
- `compaction.ts:972` — scrubs text before sending to LLM summarizer. No new message row is created; no counting needed.
- `sensitive.ts:230` — preview command that scrubs user-provided input for display. No DB writes.

Both are one-line fixes: append `.text`.

- [ ] **Step 5.1 — Update `src/compaction.ts`**

Find the line (around line 972):

```typescript
    const sourceText = this.config.scrubber ? this.config.scrubber.scrub(rawText) : rawText;
```

Change to:

```typescript
    const sourceText = this.config.scrubber ? this.config.scrubber.scrub(rawText).text : rawText;
```

- [ ] **Step 5.2 — Update `src/sensitive.ts`**

Find the line (around line 230):

```typescript
  const redacted = engine.scrub(input);
```

Change to:

```typescript
  const redacted = engine.scrub(input).text;
```

- [ ] **Step 5.3 — Run the full test suite**

```bash
npm test
```

Expected: all tests pass. The type checker will have caught any missed call sites.

- [ ] **Step 5.4 — Commit**

```bash
git add src/compaction.ts src/sensitive.ts
git commit -m "fix: update non-counting scrub call sites to use .text"
```

---

## Task 6: Add redaction stats to `stats.ts` + Security section

**Files:**
- Modify: `src/stats.ts`
- Modify: `test/stats.test.ts`

### Context

`src/stats.ts` exports three things used by this task:
- `interface OverallStats` (line 18) — needs a `redactionCounts` field
- `function queryProjectStats(dbPath: string)` (line 32) — private; reads one project DB; needs to query `message_redactions`
- `function collectStats()` (line 227) — reads all project DBs; needs to sum `redactionCounts`
- `function printStats(stats: OverallStats, verbose: boolean)` (line 123) — renders output; needs a Security section

Also import `RedactionCounts` from `scrub.ts`.

- [ ] **Step 6.1 — Write failing tests**

In `test/stats.test.ts`, add after the existing `printStats` tests:

```typescript
describe("printStats Security section", () => {
  it("renders Security section when total redactions > 0", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    printStats(
      {
        projects: 1,
        conversations: 1,
        compactedConversations: 0,
        messages: 5,
        summaries: 0,
        maxDepth: 0,
        rawTokens: 0,
        summaryTokens: 0,
        ratio: 0,
        promotedCount: 0,
        conversationDetails: [],
        redactionCounts: { builtIn: 139, global: 2, project: 1 },
      },
      false,
    );

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Security");
    expect(output).toContain("142");
    expect(output).toContain("built-in: 139");
    expect(output).toContain("global: 2");
    expect(output).toContain("project: 1");

    consoleSpy.mockRestore();
  });

  it("does not render Security section when total redactions === 0", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    printStats(
      {
        projects: 1,
        conversations: 1,
        compactedConversations: 0,
        messages: 5,
        summaries: 0,
        maxDepth: 0,
        rawTokens: 0,
        summaryTokens: 0,
        ratio: 0,
        promotedCount: 0,
        conversationDetails: [],
        redactionCounts: { builtIn: 0, global: 0, project: 0 },
      },
      false,
    );

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).not.toContain("Security");

    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 6.2 — Run tests to confirm they fail**

```bash
npm test -- --run test/stats.test.ts
```

Expected: TypeScript error or runtime failure — `redactionCounts` field does not exist on `OverallStats`.

- [ ] **Step 6.3 — Update `src/stats.ts`**

**a) Add import at the top** (after existing imports):

```typescript
import type { RedactionCounts } from "./scrub.js";
```

**b) Add `redactionCounts` to `OverallStats`:**

```typescript
interface OverallStats {
  projects: number;
  conversations: number;
  compactedConversations: number;
  messages: number;
  summaries: number;
  maxDepth: number;
  rawTokens: number;
  summaryTokens: number;
  ratio: number;
  promotedCount: number;
  conversationDetails: ConversationStats[];
  redactionCounts: RedactionCounts;   // ← add this line
}
```

**c) Add redaction query inside `queryProjectStats`** (after the `promoted` query, before `return {`):

```typescript
    const redactionRows = db.prepare(`
      SELECT category, COALESCE(SUM(count), 0) as total
      FROM message_redactions
      GROUP BY category
    `).all() as { category: string; total: number }[];

    const redactionCounts: RedactionCounts = { builtIn: 0, global: 0, project: 0 };
    for (const row of redactionRows) {
      if (row.category === "builtIn" || row.category === "global" || row.category === "project") {
        redactionCounts[row.category] = Number(row.total);
      }
    }
```

Add `redactionCounts` to the return object of `queryProjectStats`:

```typescript
    return {
      conversations: convRows.length,
      compactedConversations: compacted.length,
      messages: msgStats.count,
      summaries: sumStats.count,
      maxDepth: sumStats.maxDepth,
      rawTokens: compactedRaw,
      summaryTokens: compactedSum,
      ratio: compactedSum > 0 && compactedRaw > 0 ? compactedRaw / compactedSum : 0,
      promotedCount: promoted.count,
      conversationDetails,
      redactionCounts,   // ← add
    };
```

**d) Add totals variable and accumulation in `collectStats`:**

After the `let totalPromoted = 0;` line, add:

```typescript
  let totalRedactions: RedactionCounts = { builtIn: 0, global: 0, project: 0 };
```

Inside the loop, after `totalPromoted += projStats.promotedCount;`, add:

```typescript
      totalRedactions = {
        builtIn: totalRedactions.builtIn + projStats.redactionCounts.builtIn,
        global: totalRedactions.global + projStats.redactionCounts.global,
        project: totalRedactions.project + projStats.redactionCounts.project,
      };
```

Add `redactionCounts: totalRedactions` to the final return object of `collectStats`.

Also update the early-return at the top of `collectStats` (when `baseDir` does not exist):

```typescript
    return {
      projects: 0, conversations: 0, compactedConversations: 0, messages: 0, summaries: 0,
      maxDepth: 0, rawTokens: 0, summaryTokens: 0, ratio: 0,
      promotedCount: 0, conversationDetails: [],
      redactionCounts: { builtIn: 0, global: 0, project: 0 },
    };
```

**e) Add Security section to `printStats`** (after the Compression block, before the verbose Per Conversation block):

```typescript
  // Security section (only when any redactions have been made)
  const redactTotal =
    stats.redactionCounts.builtIn +
    stats.redactionCounts.global +
    stats.redactionCounts.project;
  if (redactTotal > 0) {
    console.log();
    console.log(sectionHeader("Security"));
    console.log();
    const { builtIn, global: globalCount, project } = stats.redactionCounts;
    console.log(
      `    \uD83D\uDD12 ${dim}redactions${reset}  ${formatNumber(redactTotal)} total  ${dim}(built-in: ${builtIn}  global: ${globalCount}  project: ${project})${reset}`,
    );
  }
```

> The `\uD83D\uDD12` escape is the 🔒 emoji, safe across all terminals that support Unicode.

- [ ] **Step 6.4 — Run tests to confirm they pass**

```bash
npm test -- --run test/stats.test.ts
```

Expected: all tests pass.

- [ ] **Step 6.5 — Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6.6 — Commit**

```bash
git add src/stats.ts test/stats.test.ts
git commit -m "feat(stats): add redactionCounts to OverallStats and render Security section"
```

---

## Task 7: Add `GET /stats` daemon route

**Files:**
- Create: `src/daemon/routes/stats.ts`
- Create: `test/daemon/routes/stats.test.ts`
- Modify: `src/daemon/server.ts`

### Context

`createDaemon` in `src/daemon/server.ts` registers routes via `routes.set("METHOD /path", handler)`. All route handlers follow the `RouteHandler = (req, res, body) => Promise<void>` signature. `collectStats()` from `src/stats.ts` reads all project DBs synchronously and returns `OverallStats`.

- [ ] **Step 7.1 — Write the failing test**

Create `test/daemon/routes/stats.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

describe("GET /stats route", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns 200 with OverallStats shape including redactionCounts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-stats-route-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: [] },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("conversations");
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("redactionCounts");
    expect(body.redactionCounts).toMatchObject({
      builtIn: expect.any(Number),
      global: expect.any(Number),
      project: expect.any(Number),
    });
  });
});
```

- [ ] **Step 7.2 — Run test to confirm it fails**

```bash
npm test -- --run test/daemon/routes/stats.test.ts
```

Expected: 404 or connection error — `GET /stats` route does not exist yet.

- [ ] **Step 7.3 — Create `src/daemon/routes/stats.ts`**

```typescript
import { collectStats } from "../../stats.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";

export function createStatsHandler(): RouteHandler {
  return async (_req, res, _body) => {
    try {
      const stats = collectStats();
      sendJson(res, 200, stats);
    } catch {
      sendJson(res, 500, { error: "Stats collection failed" });
    }
  };
}
```

- [ ] **Step 7.4 — Register the route in `src/daemon/server.ts`**

Add import after the existing route imports:

```typescript
import { createStatsHandler } from "./routes/stats.js";
```

Add the route registration after the `GET /health` line:

```typescript
  routes.set("GET /stats", createStatsHandler());
```

- [ ] **Step 7.5 — Run the full test suite**

```bash
npm test
```

Expected: all tests pass, including the new GET /stats test.

- [ ] **Step 7.6 — Manual smoke test (optional but recommended)**

```bash
npm run build
lcm start &
sleep 1
curl -s http://127.0.0.1:$(lcm doctor --json 2>/dev/null | jq -r '.daemonPort // 7032')/stats | jq '.redactionCounts'
lcm stop
```

Expected: JSON with `{ builtIn: N, global: N, project: N }`.

- [ ] **Step 7.7 — Commit**

```bash
git add src/daemon/routes/stats.ts src/daemon/server.ts test/daemon/routes/stats.test.ts
git commit -m "feat(daemon): add GET /stats route exposing OverallStats as JSON"
```

---

## Final Check

- [ ] **Run full test suite one last time**

```bash
npm test
```

Expected: all tests pass, zero failures.

- [ ] **Build to catch type errors**

```bash
npm run build
```

Expected: exits 0 with no TypeScript errors.

- [ ] **Final commit (if build produced dist changes)**

```bash
git add dist/
git commit -m "chore: rebuild dist for redaction-stats feature"
```
