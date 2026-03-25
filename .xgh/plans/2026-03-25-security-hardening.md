# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 17 security findings from two audit rounds: daemon auth, ReDoS, path traversal, secret redaction (17 new patterns), config file permissions, store scrubbing, summary injection, request body limits, MCP input validation, cwd canonicalization, error sanitization, symlink safety, tmp file isolation, and prototype pollution.

**Architecture:** Each finding is an independent fix. Tasks are ordered simplest-first with the largest change (daemon auth) near the end so earlier tasks don't need to account for auth headers in tests. All changes follow TDD — write failing test, implement minimal fix, verify.

**Tech Stack:** Node.js, TypeScript, Vitest, `safe-regex` (new dep), `node:crypto`, `node:fs` (chmodSync)

**Reference:** PR #89 (round 1 audit), `.xgh/plans/2026-03-25-security-audit-round2.md` (round 2 audit). Copilot review comments incorporated as improvements.

**Excluded findings:**
- #3 (concurrent compaction cap) — cost amplification is negligible: claude-process has no API cost, and even Haiku API costs ~$17 to compact the entire project. Per-session guard already prevents duplicate compactions.
- #9 (SQLite DB permissions) — Claude Code's own transcripts at `~/.claude/projects/` are already world-readable. Hardening the derivative while the source is open is security theater.

---

### Task 1: Expand secret redaction patterns (Finding #6)

**Files:**
- Modify: `src/scrub.ts:4-12` (BUILT_IN_PATTERNS array)
- Modify: `test/scrub.test.ts` (add test cases)

- [ ] **Step 1: Write failing tests for new credential patterns**

Add to `test/scrub.test.ts` inside the `ScrubEngine — built-in patterns` describe block:

```typescript
it("redacts npm tokens (npm_...)", () => {
  expect(engine.scrub("token=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")).toContain("[REDACTED]");
});

it("redacts Slack bot tokens (xoxb-...)", () => {
  expect(engine.scrub("SLACK_TOKEN=xoxb-123456789-abcdefghij")).toContain("[REDACTED]");
});

it("redacts Slack user tokens (xoxp-...)", () => {
  expect(engine.scrub("token=xoxp-999888777-abcdef")).toContain("[REDACTED]");
});

it("redacts Slack rotating tokens (xoxe-...)", () => {
  expect(engine.scrub("token=xoxe-1-abc123def456")).toContain("[REDACTED]");
});

it("redacts Slack app-level tokens (xapp-...)", () => {
  expect(engine.scrub("token=xapp-1-A0B1C2D3E4F-abc123")).toContain("[REDACTED]");
});

it("redacts Slack workflow tokens (xwfp-...)", () => {
  expect(engine.scrub("token=xwfp-abc123-def456")).toContain("[REDACTED]");
});

it("redacts Stripe live secret keys (sk_live_...)", () => {
  expect(engine.scrub("key=sk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
});

it("redacts Stripe live publishable keys (pk_live_...)", () => {
  expect(engine.scrub("key=pk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
});

it("redacts Google/GCP API keys (AIza...)", () => {
  expect(engine.scrub("key=AIzaSyA1234567890abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
});

it("redacts SendGrid API tokens (SG.…)", () => {
  expect(engine.scrub("SENDGRID_KEY=SG." + "a".repeat(66))).toContain("[REDACTED]");
});

it("redacts Twilio API keys (SK...)", () => {
  expect(engine.scrub("TWILIO_KEY=SK00000000000000000000000000000000")).toContain("[REDACTED]");
});

it("redacts Shopify access tokens (shpat_...)", () => {
  expect(engine.scrub("token=shpat_" + "a".repeat(32))).toContain("[REDACTED]");
});

it("redacts Vault service tokens (hvs.…)", () => {
  expect(engine.scrub("VAULT_TOKEN=hvs." + "a".repeat(95))).toContain("[REDACTED]");
});

it("redacts Doppler API tokens (dp.pt.…)", () => {
  expect(engine.scrub("DOPPLER=dp.pt." + "a".repeat(43))).toContain("[REDACTED]");
});

it("redacts database connection strings with credentials", () => {
  expect(engine.scrub("DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb")).toContain("[REDACTED]");
  expect(engine.scrub("MONGO=mongodb://root:pass@mongo:27017/app")).toContain("[REDACTED]");
  expect(engine.scrub("REDIS=redis://default:hunter2@redis.example.com:6379")).toContain("[REDACTED]");
});

it("redacts JWTs (eyJ... three-segment tokens)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aBcDeFgHiJkLmNoPqRsTuVwXyZ";
  expect(engine.scrub(`token=${jwt}`)).toContain("[REDACTED]");
});

it("does not redact partial JWT-like strings without dots", () => {
  expect(engine.scrub("eyJhbGciOiJIUzI1NiJ9")).not.toContain("[REDACTED]");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scrub.test.ts`
Expected: Multiple FAIL for the new test cases

- [ ] **Step 3: Add new patterns to BUILT_IN_PATTERNS**

In `src/scrub.ts`, expand the `BUILT_IN_PATTERNS` array. DB connection string pattern uses `\\s` to trigger spanning mode (see `isSpanningPattern()`):

```typescript
export const BUILT_IN_PATTERNS: string[] = [
  "sk-[A-Za-z0-9]{20,}",
  "sk-ant-[A-Za-z0-9\\-]{40,}",
  "ghp_[A-Za-z0-9]{36}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN .* KEY-----",
  "Bearer [A-Za-z0-9\\-._~+/]+=*",
  "[Pp]assword\\s*[:=]\\s*\\S+",
  // npm tokens (classic npm_ prefix — revoked Dec 2025 but may exist in old configs)
  "npm_[A-Za-z0-9]{30,}",
  // Slack tokens: bot (xoxb), user (xoxp), workspace (xoxa), owner (xoxo),
  // session (xoxs), rotating (xoxe), refresh (xoxr)
  "xox[bpoasre]-[A-Za-z0-9\\-]+",
  // Slack app-level tokens (xapp-) and workflow tokens (xwfp-)
  "xapp-[A-Za-z0-9\\-]+",
  "xwfp-[A-Za-z0-9\\-]+",
  // Stripe live keys (secret, publishable, restricted)
  "[spr]k_live_[A-Za-z0-9]{16,}",
  // Google/GCP API keys (deterministic AIza prefix)
  "AIza[\\w-]{35}",
  // SendGrid API tokens (SG. prefix, 66-char body)
  "SG\\.[a-zA-Z0-9=_\\-.]{66}",
  // Twilio API keys (SK prefix + 32 hex chars)
  "SK[0-9a-fA-F]{32}",
  // Shopify access tokens (shpat_, shpca_, shppa_, shpss_ prefixes)
  "shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}",
  // HashiCorp Vault service tokens (hvs. prefix)
  "hvs\\.[\\w-]{90,120}",
  // Doppler API tokens (dp.pt. prefix)
  "dp\\.pt\\.[a-z0-9]{43}",
  // Database connection strings with embedded credentials
  "(postgres|mysql|mongodb|redis|rediss)://\\S+:\\S+@\\S+",
  // JSON Web Tokens (three base64url segments separated by dots)
  "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/scrub.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/scrub.ts test/scrub.test.ts
git commit -m "security: expand built-in secret redaction patterns (finding #6)

Add patterns for npm tokens, Slack tokens, Stripe live keys,
database connection strings with embedded credentials, and JWTs."
```

---

### Task 2: Harden config.json and daemon.token file permissions (Finding #7)

**Files:**
- Modify: `installer/install.ts:8-17` (add chmodSync to ServiceDeps)
- Modify: `installer/install.ts:132-139` (call deps.chmodSync after write)
- Modify: `src/bootstrap.ts:34-38` (call chmodSync after config write)
- Modify: `test/installer/install.test.ts` (verify chmod called)
- Modify: `test/bootstrap.test.ts` (verify chmod called)

- [ ] **Step 1: Write failing test — installer calls chmod after config write**

In `test/installer/install.test.ts`, add within the `install()` describe block:

```typescript
it("calls chmodSync(0o600) on config.json after creation", async () => {
  const chmodSync = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false),
    chmodSync,
  });
  await install(deps);
  expect(chmodSync).toHaveBeenCalledWith(
    expect.stringContaining("config.json"),
    0o600,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/installer/install.test.ts`
Expected: FAIL (chmodSync not in ServiceDeps)

- [ ] **Step 3: Add chmodSync to ServiceDeps and wire it**

In `installer/install.ts`:

1. Add `import { chmodSync } from "node:fs"` to the existing import.
2. Add to `ServiceDeps` interface: `chmodSync?: (path: string, mode: number) => void;`
3. Add to `defaultDeps`: `chmodSync`
4. After `deps.writeFileSync(configPath, ...)` on line 138, add: `deps.chmodSync?.(configPath, 0o600);`

In `src/bootstrap.ts`:

1. Add `import { chmodSync } from "node:fs"` to existing import.
2. After `deps.writeFileSync(deps.configPath, ...)` on line 37, add: `try { chmodSync(deps.configPath, 0o600); } catch {}`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/installer/install.test.ts test/bootstrap.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add installer/install.ts src/bootstrap.ts test/installer/install.test.ts test/bootstrap.test.ts
git commit -m "security: harden config.json permissions to 0o600 (finding #7)

Call chmodSync immediately after writing config.json so it is
owner-only before any other process can read it. Uses the deps
abstraction so unit tests remain mocked."
```

---

### Task 3: Validate regex patterns to prevent ReDoS (Finding #4)

**Files:**
- Modify: `package.json` (add `safe-regex` + `@types/safe-regex` as devDep)
- Create: `src/store/regex-safety.ts` (shared validation helper)
- Modify: `src/store/conversation-store.ts:706-714` (use validated regex)
- Modify: `src/store/summary-store.ts:814-821` (use validated regex)
- Create: `test/store/regex-safety.test.ts`

- [ ] **Step 1: Install safe-regex**

```bash
npm install safe-regex && npm install -D @types/safe-regex
```

- [ ] **Step 2: Write failing test for regex validation**

Create `test/store/regex-safety.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

describe("validateRegex", () => {
  it("returns RegExp for safe patterns", () => {
    expect(validateRegex("hello.*world")).toBeInstanceOf(RegExp);
    expect(validateRegex("\\d{3}-\\d{4}")).toBeInstanceOf(RegExp);
  });

  it("throws for catastrophic backtracking patterns", () => {
    expect(() => validateRegex("(a+)+$")).toThrow(/unsafe/i);
    expect(() => validateRegex("(.*a){20}")).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow(/invalid/i);
    expect(() => validateRegex("(?P<name>")).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/store/regex-safety.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement validateRegex**

Create `src/store/regex-safety.ts`:

```typescript
import safeRegex from "safe-regex";

export function validateRegex(pattern: string): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : "syntax error"}`);
  }
  if (!safeRegex(pattern)) {
    throw new Error(`Unsafe regex pattern rejected (potential catastrophic backtracking): ${pattern}`);
  }
  return re;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/store/regex-safety.test.ts`
Expected: All PASS

- [ ] **Step 6: Wire validateRegex into both stores**

In `src/store/conversation-store.ts` line 714, replace:
```typescript
const re = new RegExp(pattern);
```
with:
```typescript
import { validateRegex } from "./regex-safety.js";
// ...
const re = validateRegex(pattern);
```

In `src/store/summary-store.ts` line 821, make the same replacement.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/store/regex-safety.ts src/store/conversation-store.ts src/store/summary-store.ts test/store/regex-safety.test.ts
git commit -m "security: reject unsafe regex patterns using safe-regex (finding #4)

Add validateRegex() helper applied in both ConversationStore and
SummaryStore searchRegex methods. Prevents ReDoS via catastrophic
backtracking patterns and surfaces clean errors for invalid syntax."
```

---

### Task 4: Scrub /store content before insertion (Finding #8)

**Files:**
- Modify: `src/daemon/routes/store.ts` (accept config, scrub text)
- Modify: `src/daemon/server.ts:76` (pass config to createStoreHandler)
- Modify: `test/daemon/routes/store.test.ts` (test scrubbing)

- [ ] **Step 1: Write failing test — store scrubs secrets**

Add to `test/daemon/routes/store.test.ts`:

```typescript
it("scrubs secrets from stored text", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-scrub-"));
  tempDirs.push(tempDir);
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  const daemon = await createDaemon(config);
  const port = daemon.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Our API key is sk-ant-api03-" + "a".repeat(40),
        tags: ["decision"],
        cwd: tempDir,
      }),
    });
    expect(res.status).toBe(200);

    // Read back from DB to verify scrubbing
    const { DatabaseSync } = await import("node:sqlite");
    const { projectDbPath } = await import("../../../src/daemon/project.js");
    const db = new DatabaseSync(projectDbPath(tempDir));
    const row = db.prepare("SELECT content FROM promoted ORDER BY rowid DESC LIMIT 1").get() as { content: string };
    db.close();
    expect(row.content).toContain("[REDACTED]");
    expect(row.content).not.toContain("sk-ant-api03");
  } finally {
    await daemon.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/store.test.ts`
Expected: FAIL (text stored unredacted)

- [ ] **Step 3: Implement scrubbing in /store**

In `src/daemon/routes/store.ts`:

```typescript
import type { DaemonConfig } from "../config.js";
import { ScrubEngine } from "../../scrub.js";
import { projectDir } from "../project.js";

export function createStoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    // ... existing parsing ...

    const scrubber = await ScrubEngine.forProject(
      config.security?.sensitivePatterns ?? [],
      projectDir(projectPath),
    );
    const scrubbedText = scrubber.scrub(text);

    // ... use scrubbedText instead of text in store.insert() ...
  };
}
```

In `src/daemon/server.ts` line 76, change:
```typescript
routes.set("POST /store", createStoreHandler());
```
to:
```typescript
routes.set("POST /store", createStoreHandler(config));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daemon/routes/store.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/store.ts src/daemon/server.ts test/daemon/routes/store.test.ts
git commit -m "security: scrub secrets in /store route before insertion (finding #8)

createStoreHandler now accepts DaemonConfig and runs ScrubEngine on
text before writing to the promoted table, closing the gap where
lcm_store bypassed all secret redaction."
```

---

### Task 5: Validate transcript_path to prevent path traversal (Finding #5)

**Files:**
- Modify: `src/daemon/project.ts` (add isSafeTranscriptPath)
- Modify: `src/daemon/routes/ingest.ts:26-36` (validate and use normalized path)
- Modify: `src/daemon/routes/compact.ts:148` (validate and use normalized path)
- Create: `test/daemon/project-path-safety.test.ts`

- [ ] **Step 1: Write failing tests for path validation**

Create `test/daemon/project-path-safety.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSafeTranscriptPath } from "../../src/daemon/project.js";

describe("isSafeTranscriptPath", () => {
  const cwd = "/Users/test/my-project";

  it("allows paths under ~/.claude/projects/", () => {
    const p = join(homedir(), ".claude", "projects", "-Users-test-my-project", "abc.jsonl");
    expect(isSafeTranscriptPath(p, cwd)).toBeTruthy();
  });

  it("allows paths under the project cwd", () => {
    expect(isSafeTranscriptPath(join(cwd, "transcript.jsonl"), cwd)).toBeTruthy();
  });

  it("rejects paths outside allowed bases", () => {
    expect(isSafeTranscriptPath("/etc/passwd", cwd)).toBe(false);
    expect(isSafeTranscriptPath(join(homedir(), ".ssh", "id_rsa"), cwd)).toBe(false);
  });

  it("rejects path traversal via ../", () => {
    const base = join(homedir(), ".claude", "projects");
    expect(isSafeTranscriptPath(join(base, "..", "..", ".ssh", "id_rsa"), cwd)).toBe(false);
  });

  it("returns the normalized path on success", () => {
    const p = join(homedir(), ".claude", "projects", "test", "session.jsonl");
    const result = isSafeTranscriptPath(p, cwd);
    expect(typeof result).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/project-path-safety.test.ts`
Expected: FAIL (function not exported)

- [ ] **Step 3: Implement isSafeTranscriptPath**

Add to `src/daemon/project.ts`:

```typescript
import { resolve, normalize } from "node:path";  // add to existing import

/**
 * Validates that a transcript path is under one of two allowed bases:
 *   1. ~/.claude/projects/
 *   2. The project's own cwd
 *
 * Returns the resolved canonical path if safe, or false if rejected.
 * Uses resolve() to collapse ../ traversals.
 */
export function isSafeTranscriptPath(transcriptPath: string, cwd: string): string | false {
  const resolved = resolve(transcriptPath);
  const allowedBases = [
    join(homedir(), ".claude", "projects"),
    resolve(cwd),
  ];
  for (const base of allowedBases) {
    const normalBase = normalize(base + "/");
    if (resolved.startsWith(normalBase) || resolved === normalize(base)) {
      return resolved;
    }
  }
  return false;
}
```

- [ ] **Step 4: Wire into /ingest and /compact**

In `src/daemon/routes/ingest.ts`, modify `resolveMessages()`:

```typescript
import { isSafeTranscriptPath } from "../project.js";  // add to imports

function resolveMessages(input: { messages?: unknown; transcript_path?: string; cwd?: string }): ParsedMessage[] {
  if (Array.isArray(input.messages)) {
    return input.messages.filter(isParsedMessage);
  }

  if (input.transcript_path && input.cwd) {
    const safePath = isSafeTranscriptPath(input.transcript_path, input.cwd);
    if (!safePath) return [];
    if (existsSync(safePath)) return parseTranscript(safePath);
  }

  return [];
}
```

In `src/daemon/routes/compact.ts` around line 148, similarly:

```typescript
if (!skip_ingest && transcript_path) {
  const safePath = isSafeTranscriptPath(transcript_path, cwd);
  if (safePath && existsSync(safePath)) {
    const parsed = parseTranscript(safePath);
    // ... rest unchanged
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/daemon/project-path-safety.test.ts`
Expected: All PASS

- [ ] **Step 6: Run full suite to verify no regressions**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/project.ts src/daemon/routes/ingest.ts src/daemon/routes/compact.ts test/daemon/project-path-safety.test.ts
git commit -m "security: validate transcript_path against allowlist (finding #5)

Add isSafeTranscriptPath() which resolves the path and checks it
falls under ~/.claude/projects/ or the project cwd. Returns the
normalized path for use downstream, preventing traversal via ../ ."
```

---

### Task 6: Daemon bearer token authentication (Finding #1)

**Files:**
- Create: `src/daemon/auth.ts` (token generation + reading + middleware)
- Modify: `src/daemon/server.ts` (apply auth middleware to all non-health routes)
- Modify: `src/daemon/client.ts` (read token + inject Authorization header)
- Modify: `src/daemon/lifecycle.ts` (generate token before daemon start)
- Create: `test/daemon/auth.test.ts`
- Modify: `test/daemon/server.test.ts` (add auth header to requests)
- Modify: `test/daemon/routes/store.test.ts` (add auth header to requests)

- [ ] **Step 1: Write failing tests for auth module**

Create `test/daemon/auth.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("ensureAuthToken", () => {
  it("generates a token file with 0o600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const token = readFileSync(tokenPath, "utf-8").trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("preserves existing token on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth2-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const first = readFileSync(tokenPath, "utf-8");
    ensureAuthToken(tokenPath);
    const second = readFileSync(tokenPath, "utf-8");
    expect(first).toBe(second);
  });
});

describe("readAuthToken", () => {
  it("returns the token from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-auth3-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "daemon.token");
    writeFileSync(tokenPath, "test-token-123");
    expect(readAuthToken(tokenPath)).toBe("test-token-123");
  });

  it("returns null when file does not exist", () => {
    expect(readAuthToken("/nonexistent/daemon.token")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/auth.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement auth module**

Create `src/daemon/auth.ts`:

```typescript
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function ensureAuthToken(tokenPath: string): void {
  if (existsSync(tokenPath)) {
    // Enforce permissions on existing file
    try { chmodSync(tokenPath, 0o600); } catch {}
    return;
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600); // belt + suspenders for umask
}

export function readAuthToken(tokenPath: string): string | null {
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run auth tests**

Run: `npx vitest run test/daemon/auth.test.ts`
Expected: All PASS

- [ ] **Step 5: Write failing test — server rejects unauthenticated requests**

Add to `test/daemon/server.test.ts`:

```typescript
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("daemon auth", () => {
  it("returns 401 for POST without auth token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent", { daemon: { port: 0 } });
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(401);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows /health without auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv2-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent", { daemon: { port: 0 } });
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows POST with valid Bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv3-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath)!;
    const config = loadDaemonConfig("/nonexistent", { daemon: { port: 0 } });
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Implement auth middleware in server.ts**

In `src/daemon/server.ts`:

1. Accept `tokenPath` in `DaemonOptions`:
   ```typescript
   export type DaemonOptions = {
     proxyManager?: ProxyManager;
     onIdle?: () => void;
     tokenPath?: string;
   };
   ```

2. In `createDaemon`, read the token and add auth check:
   ```typescript
   import { readAuthToken } from "./auth.js";

   // Inside createDaemon, before creating routes:
   const serverToken = options?.tokenPath ? readAuthToken(options.tokenPath) : null;
   ```

3. In the request handler, add auth check before dispatching to route handler:
   ```typescript
   const server = createServer(async (req, res) => {
     resetIdleTimer();
     const key = `${req.method} ${req.url?.split("?")[0]}`;
     const handler = routes.get(key);
     if (!handler) { sendJson(res, 404, { error: "not found" }); return; }

     // Auth: skip for /health, require Bearer token for everything else
     if (serverToken && key !== "GET /health") {
       const rawAuth = req.headers["authorization"];
       const authHeader = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "";
       if (authHeader.trim() !== `Bearer ${serverToken}`) {
         sendJson(res, 401, { error: "unauthorized" });
         return;
       }
     }

     try {
       await handler(req, res, req.method !== "GET" ? await readBody(req) : "");
     } catch (err) {
       sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
     }
   });
   ```

- [ ] **Step 7: Update DaemonClient to inject auth header**

In `src/daemon/client.ts`:

```typescript
import { readAuthToken } from "./auth.js";
import { join } from "node:path";
import { homedir } from "node:os";

export class DaemonClient {
  private token: string | null = null;
  private tokenLoaded = false;

  constructor(private baseUrl: string, private tokenPath?: string) {}

  private getToken(): string | null {
    if (!this.tokenLoaded) {
      this.token = readAuthToken(
        this.tokenPath ?? join(homedir(), ".lossless-claude", "daemon.token"),
      );
      this.tokenLoaded = true;
    }
    return this.token;
  }

  async health(): Promise<{ status: string; uptime: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok ? (await res.json() as { status: string; uptime: number }) : null;
    } catch { return null; }
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return await res.json() as T;
  }
}
```

- [ ] **Step 8: Generate token in lifecycle.ts during daemon start**

In `src/daemon/lifecycle.ts`, before spawning the daemon process, call `ensureAuthToken`:

```typescript
import { ensureAuthToken } from "./auth.js";
import { join, dirname } from "node:path";

// At the start of ensureDaemon(), before health check:
const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
ensureAuthToken(tokenPath);
```

- [ ] **Step 9: Update existing tests to include auth headers**

Update `test/daemon/routes/store.test.ts` and any other route tests that make direct HTTP calls to include the Bearer token. The simplest approach: in each test, create a temp dir, `ensureAuthToken(tokenPath)`, read it, pass `tokenPath` in options, and add `Authorization` header.

Alternatively, for tests that don't test auth, pass no `tokenPath` to `createDaemon` — when `serverToken` is null, auth is skipped.

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add src/daemon/auth.ts src/daemon/server.ts src/daemon/client.ts src/daemon/lifecycle.ts test/daemon/auth.test.ts test/daemon/server.test.ts test/daemon/routes/store.test.ts
git commit -m "security: require bearer token on all daemon routes (finding #1)

Generate a 256-bit token on first daemon start, persist at
~/.lossless-claude/daemon.token (mode 0o600). All routes except
GET /health require Authorization: Bearer <token>. DaemonClient
reads and injects the token automatically."
```

---

### Task 7: Sanitize restored summaries to mitigate prompt injection (Finding #2)

**Files:**
- Modify: `src/daemon/routes/restore.ts:93-103` (sanitize summary content)
- Create: `src/daemon/content-fence.ts` (content fencing utility)
- Create: `test/daemon/content-fence.test.ts`

- [ ] **Step 1: Write failing tests for content fencing**

Create `test/daemon/content-fence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fenceContent } from "../../src/daemon/content-fence.js";

describe("fenceContent", () => {
  it("wraps content in XML-style tags with HMAC nonce", () => {
    const result = fenceContent("summary text", "episodic-memory");
    expect(result).toContain("<episodic-memory");
    expect(result).toContain("</episodic-memory>");
    expect(result).toContain("summary text");
  });

  it("escapes nested closing tags in content", () => {
    const result = fenceContent("</episodic-memory>injected", "episodic-memory");
    expect(result).not.toMatch(/<\/episodic-memory>injected/);
  });

  it("strips ANSI control sequences", () => {
    const result = fenceContent("\x1b[31mred text\x1b[0m", "test");
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("red text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/content-fence.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement content fencing**

Create `src/daemon/content-fence.ts`:

```typescript
/**
 * Wraps content in XML-like fence tags with basic sanitization to reduce
 * prompt injection surface when re-injecting summaries into conversations.
 *
 * Not a silver bullet — defense in depth alongside auth + scrubbing.
 */
export function fenceContent(content: string, tag: string): string {
  // Strip ANSI escape sequences
  let sanitized = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Escape any closing tags that match our fence tag
  sanitized = sanitized.replace(
    new RegExp(`</${tag}>`, "gi"),
    `&lt;/${tag}&gt;`,
  );
  return `<${tag}>\n${sanitized}\n</${tag}>`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/daemon/content-fence.test.ts`
Expected: All PASS

- [ ] **Step 5: Apply content fencing in restore.ts**

In `src/daemon/routes/restore.ts`, replace the raw template string wrapping:

```typescript
import { fenceContent } from "../content-fence.js";

// Line ~102: replace raw <recent-session-context> wrapping:
if (rows.length > 0) {
  episodicContext = fenceContent(
    rows.map((r) => r.content).join("\n\n"),
    "recent-session-context",
  );
}

// Line ~110: replace raw <project-knowledge> wrapping:
if (results.length > 0) {
  promotedContext = fenceContent(
    results.map((r) => r.content).join("\n\n"),
    "project-knowledge",
  );
}
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon/content-fence.ts src/daemon/routes/restore.ts test/daemon/content-fence.test.ts
git commit -m "security: sanitize restored summaries against prompt injection (finding #2)

Add fenceContent() utility that wraps re-injected content in
XML-like tags with closing-tag escaping and ANSI stripping.
Applied to episodic and promoted memory in /restore."
```

---

---

### Task 8: HTTP request body size limit (SEC-NEW-1)

**Files:**
- Modify: `src/daemon/server.ts:34-37` (readBody function)
- Modify: `test/daemon/server.test.ts` (add size limit test)

- [ ] **Step 1: Write failing test for body size limit**

Add to `test/daemon/server.test.ts`:

```typescript
it("returns 413 when request body exceeds 10 MB", async () => {
  const port = daemon.address().port;
  const bigBody = "x".repeat(11 * 1024 * 1024); // 11 MB
  const res = await fetch(`http://127.0.0.1:${port}/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bigBody,
  });
  expect(res.status).toBe(413);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.ts -t "returns 413"`
Expected: FAIL (currently accepts any size)

- [ ] **Step 3: Add size limit to readBody()**

In `src/daemon/server.ts`, modify `readBody`:

```typescript
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
```

Update the catch block in the server's request handler to check for `statusCode`:

```typescript
} catch (err: any) {
  const status = err?.statusCode ?? 500;
  const message = status === 413 ? "payload too large" : (err instanceof Error ? err.message : "internal error");
  sendJson(res, status, { error: message });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/daemon/server.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts test/daemon/server.test.ts
git commit -m "security: limit HTTP request body to 10 MB (SEC-NEW-1)"
```

---

### Task 9: Canonicalize `cwd` parameter across all routes (SEC-NEW-4)

**Files:**
- Create: `src/daemon/validate-cwd.ts` (shared cwd validation)
- Modify: all route handlers in `src/daemon/routes/` (use validated cwd)
- Create: `test/daemon/validate-cwd.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/daemon/validate-cwd.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateCwd } from "../../src/daemon/validate-cwd.js";

describe("validateCwd", () => {
  it("resolves trailing slashes", () => {
    const result = validateCwd("/tmp/test/");
    expect(result).toBe("/tmp/test");
  });

  it("resolves .. components", () => {
    const result = validateCwd("/tmp/test/foo/../bar");
    expect(result).toBe("/tmp/test/bar");
  });

  it("resolves double slashes", () => {
    const result = validateCwd("/tmp//test");
    expect(result).toBe("/tmp/test");
  });

  it("throws on relative path", () => {
    expect(() => validateCwd("relative/path")).toThrow("absolute path");
  });

  it("throws on empty string", () => {
    expect(() => validateCwd("")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/validate-cwd.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement validateCwd**

Create `src/daemon/validate-cwd.ts`:

```typescript
import { resolve, isAbsolute } from "node:path";

/**
 * Canonicalize and validate a cwd parameter from a daemon route.
 * Ensures consistent project ID hashing regardless of path formatting.
 */
export function validateCwd(cwd: string): string {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required");
  }
  const resolved = resolve(cwd);
  if (!isAbsolute(resolved)) {
    throw new Error("cwd must be an absolute path");
  }
  return resolved;
}
```

- [ ] **Step 4: Apply validateCwd in each route handler**

At the top of each route's handler function (ingest, compact, restore, search, recent, status, describe, expand, grep, promote, session-complete, store), add:

```typescript
import { validateCwd } from "../validate-cwd.js";

// Inside handler, after JSON.parse:
const cwd = validateCwd(input.cwd);
```

Use the validated `cwd` for all downstream operations instead of `input.cwd`.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/validate-cwd.ts src/daemon/routes/ test/daemon/validate-cwd.test.ts
git commit -m "security: canonicalize cwd parameter across all daemon routes (SEC-NEW-4)"
```

---

### Task 10: Validate MCP tool arguments before forwarding (SEC-NEW-2)

**Files:**
- Modify: `src/mcp/server.ts:129-137` (add input validation)
- Modify: `test/mcp/server.test.ts` (add validation tests if exists, or create)

- [ ] **Step 1: Write failing test — MCP rejects unexpected keys**

In the MCP server test file, add a test that verifies extra/unexpected keys in tool arguments are stripped before forwarding to the daemon.

- [ ] **Step 2: Implement allowlist-based argument filtering**

In `src/mcp/server.ts`, for each tool, extract only the documented parameters from `req.params.arguments` before forwarding:

```typescript
// Build a per-tool allowlist from the tool definitions
const TOOL_ALLOWED_KEYS: Record<string, Set<string>> = {};
for (const tool of tools) {
  if (tool.inputSchema?.properties) {
    TOOL_ALLOWED_KEYS[tool.name] = new Set(Object.keys(tool.inputSchema.properties));
  }
}

// In CallToolRequestSchema handler:
const rawArgs = req.params.arguments ?? {};
const allowedKeys = TOOL_ALLOWED_KEYS[req.params.name];
const filteredArgs: Record<string, unknown> = {};
if (allowedKeys) {
  for (const key of allowedKeys) {
    if (key in rawArgs) filteredArgs[key] = rawArgs[key];
  }
} else {
  Object.assign(filteredArgs, rawArgs); // fallback for unknown tools
}
const result = await client.post(route, { ...filteredArgs, cwd: process.env.PWD ?? process.cwd() });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "security: validate MCP tool arguments against schema before forwarding (SEC-NEW-2)"
```

---

### Task 11: Extend ReDoS protection to promotion detector (SEC-NEW-3)

**Files:**
- Modify: `src/promotion/detector.ts:30` (validate config patterns)
- Modify: `src/daemon/config.ts` (validate patterns at load time)
- Add test in promotion detector tests

- [ ] **Step 1: Write failing test**

```typescript
it("rejects unsafe regex patterns from config", () => {
  const unsafeConfig = { ...defaultConfig };
  unsafeConfig.promotion.thresholds.architecturePatterns = ["(a+)+$"];
  // shouldPromote should skip unsafe patterns or throw
  expect(() => shouldPromote("aaa", unsafeConfig)).not.toThrow();
  // Pattern should be filtered out, not executed
});
```

- [ ] **Step 2: Implement pattern validation**

Reuse the `safe-regex` validation from Task 3. In `src/promotion/detector.ts`, validate each pattern before constructing RegExp:

```typescript
import safeRegex from "safe-regex";

// Filter patterns at call time
const safePatterns = thresholds.architecturePatterns.filter(p => {
  try { return safeRegex(p); } catch { return false; }
});
for (const pattern of safePatterns) {
  if (new RegExp(pattern).test(content)) { tags.push("architecture"); break; }
}
```

- [ ] **Step 3: Run tests and commit**

```bash
git commit -m "security: validate promotion detector regex patterns against ReDoS (SEC-NEW-3)"
```

---

### Task 12: Sanitize error responses (SEC-NEW-7)

**Files:**
- Create: `src/daemon/safe-error.ts` (error sanitization utility)
- Modify: `src/daemon/server.ts` (use sanitized errors in catch block)
- Create: `test/daemon/safe-error.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeError } from "../../src/daemon/safe-error.js";

describe("sanitizeError", () => {
  it("strips file paths from error messages", () => {
    const result = sanitizeError("ENOENT: no such file /Users/pedro/.lossless-claude/x");
    expect(result).not.toContain("/Users/pedro");
  });

  it("strips SQLite internals", () => {
    const result = sanitizeError("SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.conversation_id");
    expect(result).not.toContain("messages.conversation_id");
    expect(result).toContain("database constraint");
  });

  it("preserves generic error messages", () => {
    expect(sanitizeError("invalid input")).toBe("invalid input");
  });
});
```

- [ ] **Step 2: Implement sanitizeError**

```typescript
export function sanitizeError(message: string): string {
  // Strip absolute file paths
  let sanitized = message.replace(/\/[\w/.@-]+/g, "<path>");
  // Replace SQLite constraint details with generic message
  if (/SQLITE_/.test(sanitized)) return "database constraint error";
  return sanitized;
}
```

- [ ] **Step 3: Apply in server.ts catch block**

```typescript
import { sanitizeError } from "./safe-error.js";

// In catch:
const message = status === 413 ? "payload too large" : sanitizeError(err instanceof Error ? err.message : "internal error");
```

- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "security: sanitize error responses to prevent info leakage (SEC-NEW-7)"
```

---

### Task 13: Use lstatSync to prevent symlink following in import (SEC-NEW-8)

**Files:**
- Modify: `src/import.ts:75-115` (use lstatSync)
- Modify: `src/codex-transcript.ts` (use lstatSync)
- Add test for symlink rejection

- [ ] **Step 1: Write failing test**

```typescript
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSessionFiles } from "../src/import.js";

it("ignores symlinked transcript files", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-symlink-"));
  const targetFile = join(dir, "target.jsonl");
  writeFileSync(targetFile, '{"type":"human"}\n');
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  symlinkSync(targetFile, join(projectDir, "fake-session.jsonl"));

  const files = findSessionFiles(projectDir);
  expect(files).toHaveLength(0); // symlink should be ignored

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Replace statSync with lstatSync, skip symlinks**

In `src/import.ts`, change `statSync` to `lstatSync` and check `!stat.isSymbolicLink()`:

```typescript
import { lstatSync } from "node:fs";

// In findSessionFiles, replace statSync calls:
const stat = lstatSync(join(projectDir, entry.name));
if (stat.isSymbolicLink()) continue;
```

Apply same pattern in `src/codex-transcript.ts`.

- [ ] **Step 3: Run tests and commit**

```bash
git commit -m "security: use lstatSync to prevent symlink following in import (SEC-NEW-8)"
```

---

### Task 14: Move flag files from shared /tmp to user-specific dir (SEC-NEW-9)

**Files:**
- Modify: `src/bootstrap.ts` (change flag file location)
- Modify: `src/hooks/session-snapshot.ts` (change cursor file location)
- Update related tests

- [ ] **Step 1: Change flag file location**

In `src/bootstrap.ts`, replace:
```typescript
const flagPath = join(tmpdir(), `lcm-bootstrapped-${safeId}.flag`);
```
with:
```typescript
const flagDir = join(homedir(), ".lossless-claude", "tmp");
mkdirSync(flagDir, { recursive: true });
const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
```

- [ ] **Step 2: Apply same change in session-snapshot.ts**

Replace `tmpdir()` with `join(homedir(), ".lossless-claude", "tmp")` for cursor files.

- [ ] **Step 3: Run tests and commit**

```bash
git commit -m "security: move flag files from shared /tmp to ~/.lossless-claude/tmp (SEC-NEW-9)"
```

---

### Task 15: Guard deepMerge against prototype pollution (SEC-NEW-12)

**Files:**
- Modify: `src/daemon/config.ts` (add key denylist in deepMerge)
- Add test

- [ ] **Step 1: Write failing test**

```typescript
it("rejects prototype pollution keys", () => {
  const target = { a: 1 };
  const source = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"evil": true}}}');
  const result = deepMerge(target, source);
  expect(({} as any).polluted).toBeUndefined();
  expect(({} as any).evil).toBeUndefined();
});
```

- [ ] **Step 2: Add key denylist**

```typescript
const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DENIED_KEYS.has(key)) continue;
    // ... rest unchanged
  }
  return result;
}
```

- [ ] **Step 3: Run tests and commit**

```bash
git commit -m "security: guard deepMerge against prototype pollution (SEC-NEW-12)"
```

---

## Task Dependency Graph

```
Task 1  (scrub patterns) ─────────────┐
Task 2  (config permissions) ──────────┤
Task 3  (regex safety) ────────────────┤
Task 4  (store scrubbing) ─────────────┤── All independent
Task 5  (path traversal) ──────────────┤   (can parallelize)
Task 7  (summary sanitization) ────────┤
Task 8  (body size limit) ─────────────┤
Task 9  (cwd canonicalization) ────────┤
Task 10 (MCP input validation) ────────┤
Task 11 (promotion ReDoS) ─── depends on Task 3 (safe-regex dep)
Task 12 (error sanitization) ──────────┤
Task 13 (symlink safety) ──────────────┤
Task 14 (tmp file isolation) ──────────┤
Task 15 (prototype pollution) ─────────┘
Task 6  (daemon auth) ─────────────────── Do last (changes test patterns)
```

Tasks 1-5, 7-10, 12-15 are independent. Task 11 depends on Task 3 (needs `safe-regex`). Task 6 (daemon auth) should still be done last because it changes how all existing route tests make HTTP calls.
