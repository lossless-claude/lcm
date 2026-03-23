# Session-End Auto-Compact Implementation Plan

> **Status: IMPLEMENTED** — All tasks completed and merged to main (2026-03-21). This plan is retained as a historical record.

**Goal:** Auto-compact conversations on SessionEnd when they exceed a configurable token threshold, so every meaningful conversation gets summarized without requiring a context window overflow.

**Architecture:** Add a `compaction.autoCompactMinTokens` config field (default: 10000). After the ingest call in `handleSessionEnd`, check if the conversation's total tokens exceed the threshold. If so, fire `POST /compact` with `skip_ingest: true` (already ingested). The compact route already handles everything: summarization, promotion, meta.json, justCompacted flag.

**Tech Stack:** TypeScript, Vitest, existing CompactionEngine + DaemonClient

---

## Prior Gaps (all resolved)

All gaps below were identified before implementation and have since been resolved and merged to main.

- Gap 1 (resolved): SessionEnd now calls `/compact` after `/ingest` when threshold exceeded (`src/hooks/session-end.ts`)
- Gap 2 (resolved): `/ingest` returns `totalTokens`, enabling threshold-based compaction
- Gap 3 (resolved): `DaemonConfig.compaction.autoCompactMinTokens` added (default: 10000, 0 disables)
- Gap 4 (resolved): Tests added in `test/hooks/session-end.test.ts`, `test/daemon/routes/ingest.test.ts`, `test/daemon/routes/compact.test.ts`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/daemon/config.ts` | Add `autoCompactMinTokens` to DaemonConfig type + defaults |
| Modify | `src/hooks/session-end.ts` | After ingest, check token count → call `/compact` if above threshold |
| Create | `test/hooks/session-end.test.ts` | Unit tests for auto-compact logic |
| Modify | `test/daemon/config.test.ts` | Test new config field defaults and overrides |

---

### Task 1: Add `autoCompactMinTokens` config field

**Files:**
- Modify: `src/daemon/config.ts`
- Modify: `test/daemon/config.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// test/daemon/config.test.ts — add to existing describe block
it("includes autoCompactMinTokens default of 10000", () => {
  const c = loadDaemonConfig("/nonexistent/config.json");
  expect(c.compaction.autoCompactMinTokens).toBe(10000);
});

it("allows overriding autoCompactMinTokens", () => {
  const c = loadDaemonConfig("/nonexistent/config.json", {
    compaction: { autoCompactMinTokens: 5000 },
  });
  expect(c.compaction.autoCompactMinTokens).toBe(5000);
});

it("allows disabling auto-compact with autoCompactMinTokens: 0", () => {
  const c = loadDaemonConfig("/nonexistent/config.json", {
    compaction: { autoCompactMinTokens: 0 },
  });
  expect(c.compaction.autoCompactMinTokens).toBe(0);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/daemon/config.test.ts`
Expected: FAIL — `autoCompactMinTokens` is undefined

- [x] **Step 3: Add the field to DaemonConfig type and defaults**

In `src/daemon/config.ts`, add `autoCompactMinTokens: number` to the `compaction` section of `DaemonConfig` type, and set the default to `10000` in `DEFAULTS`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daemon/config.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/daemon/config.ts test/daemon/config.test.ts
git commit -m "feat: add autoCompactMinTokens config field (default 10000)"
```

---

### Task 2: Add auto-compact logic to SessionEnd hook

**Files:**
- Modify: `src/hooks/session-end.ts`
- Create: `test/hooks/session-end.test.ts`

- [x] **Step 1: Write failing tests for the auto-compact behavior**

```typescript
// test/hooks/session-end.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleSessionEnd } from "../../src/hooks/session-end.js";

// Mock ensureDaemon
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));

// Mock config loader
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({
    compaction: { autoCompactMinTokens: 10000 },
  }),
}));

function createMockClient(ingestResponse: any, compactResponse?: any) {
  return {
    post: vi.fn().mockImplementation((path: string) => {
      if (path === "/ingest") return Promise.resolve(ingestResponse);
      if (path === "/compact") return Promise.resolve(compactResponse ?? { summary: "done" });
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }),
  } as any;
}

describe("handleSessionEnd", () => {
  it("calls /ingest with parsed stdin", async () => {
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(stdin, client, 3737);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/ingest", { session_id: "s1", cwd: "/tmp" });
  });

  it("calls /compact when totalTokens exceeds threshold", async () => {
    const client = createMockClient(
      { ingested: 100, totalTokens: 25000 },
      { summary: "compacted" },
    );
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(client.post).toHaveBeenCalledWith("/compact", {
      session_id: "s1",
      cwd: "/tmp",
      skip_ingest: true,
      client: "claude",
    });
  });

  it("does NOT call /compact when totalTokens is below threshold", async () => {
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(client.post).toHaveBeenCalledTimes(1); // only /ingest
  });

  it("does NOT call /compact when autoCompactMinTokens is 0 (disabled)", async () => {
    // Override mock to return 0 threshold
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      compaction: { autoCompactMinTokens: 0 },
    } as any);

    const client = createMockClient({ ingested: 100, totalTokens: 99999 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(client.post).toHaveBeenCalledTimes(1); // only /ingest
  });

  it("swallows /compact errors without failing the hook", async () => {
    const client = {
      post: vi.fn().mockImplementation((path: string) => {
        if (path === "/ingest") return Promise.resolve({ ingested: 50, totalTokens: 20000 });
        if (path === "/compact") return Promise.reject(new Error("daemon crashed"));
        return Promise.reject(new Error("unexpected"));
      }),
    } as any;
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(stdin, client, 3737);
    expect(result.exitCode).toBe(0); // hook must not fail
  });

  it("calls /compact at exact threshold boundary (>=)", async () => {
    const client = createMockClient(
      { ingested: 50, totalTokens: 10000 },
      { summary: "compacted" },
    );
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(client.post).toHaveBeenCalledWith("/compact", {
      session_id: "s1",
      cwd: "/tmp",
      skip_ingest: true,
      client: "claude",
    });
  });

  it("handles empty stdin gracefully", async () => {
    const client = createMockClient({ ingested: 0 });
    const result = await handleSessionEnd("", client, 3737);
    expect(result.exitCode).toBe(0);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hooks/session-end.test.ts`
Expected: FAIL — current handleSessionEnd doesn't return totalTokens or call /compact

- [x] **Step 3: Modify ingest route to return totalTokens**

In `src/daemon/routes/ingest.ts`, after storing messages, query the total token count for the conversation and include it in the response:

```typescript
// After createMessagesBulk + appendContextMessages, before sendJson:
const totalTokens = await summaryStore.getContextTokenCount(conversation.conversationId);
sendJson(res, 200, { ingested: records.length, totalTokens });
```

Also return `totalTokens: 0` in the two early-exit paths:
- Line ~48: `sendJson(res, 200, { ingested: 0, totalTokens: 0 });` (no messages resolved)
- Line ~68: `sendJson(res, 200, { ingested: 0, totalTokens: 0 });` (no new messages)

- [x] **Step 4: Implement auto-compact in handleSessionEnd**

Update `src/hooks/session-end.ts`:

```typescript
import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { join } from "node:path";
import { homedir } from "node:os";

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 5000,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const ingestResult = await client.post<{
      ingested: number;
      totalTokens?: number;
    }>("/ingest", input);

    // Auto-compact if conversation exceeds threshold
    const configPath = join(homedir(), ".lossless-claude", "config.json");
    const config = loadDaemonConfig(configPath);
    const threshold = config.compaction.autoCompactMinTokens;

    if (
      threshold > 0 &&
      typeof ingestResult.totalTokens === "number" &&
      ingestResult.totalTokens >= threshold
    ) {
      try {
        await client.post("/compact", {
          session_id: input.session_id,
          cwd: input.cwd,
          skip_ingest: true,
          client: "claude",
        });
      } catch {
        // Non-fatal: compact failure must not break the hook
      }
    }

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/hooks/session-end.test.ts`
Expected: PASS

- [x] **Step 6: Run full test suite**

Run: `npx vitest run --dir test`
Expected: All 259+ tests pass

- [x] **Step 7: Commit**

```bash
git add src/hooks/session-end.ts src/daemon/routes/ingest.ts test/hooks/session-end.test.ts
git commit -m "feat: auto-compact on session end when tokens exceed threshold"
```

---

### Task 3: Rebuild dist and verify end-to-end

**Files:**
- Modify: `dist/` (rebuilt)

- [x] **Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors

- [x] **Step 2: Run full test suite**

Run: `npx vitest run --dir test`
Expected: All tests pass

- [x] **Step 3: Commit dist**

```bash
git add dist/
git commit -m "chore: rebuild dist with session-end auto-compact"
```
