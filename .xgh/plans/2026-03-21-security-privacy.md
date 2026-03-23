# Security & Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secrets scrubbing pipeline, `lcm sensitive` CLI, and privacy documentation to lossless-claude so secrets are redacted before SQLite storage and LLM summarization, and users have full visibility into what is stored and how to delete it.

**Architecture:** A pure `ScrubEngine` module (`src/scrub.ts`) merges built-in patterns + global config patterns + per-project patterns and applies regex redaction. It is instantiated at the three write/LLM paths: the ingest route, the compact route's inline ingest block, and the CompactionEngine leaf/condensed passes. A `lcm sensitive` CLI subcommand manages patterns by importing the shared `projectId()` helper from `src/daemon/project.ts`.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, `node:crypto` (no new deps), vitest for tests.

**Spec:** `.xgh/specs/2026-03-21-security-privacy-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/scrub.ts` | **Create** | ScrubEngine: built-in patterns, pattern merging, `scrub(text)` |
| `src/sensitive.ts` | **Create** | `handleSensitive()`: CLI logic for list/add/remove/test/purge |
| `src/daemon/config.ts` | **Modify** | Add `security: { sensitivePatterns: string[] }` to DaemonConfig |
| `src/daemon/routes/ingest.ts` | **Modify** | Scrub message content before `createMessagesBulk()` |
| `src/daemon/routes/compact.ts` | **Modify** | Scrub in inline ingest block before `createMessagesBulk()` |
| `src/compaction.ts` | **Modify** | Scrub `concatenated` in `leafPass()` (~line 1030) and `condensedPass()` (~line 1111) before LLM call |
| `src/doctor/doctor.ts` | **Modify** | Add Security section: built-in count + project pattern warning |
| `bin/lcm.ts` | **Modify** | Add `case "sensitive":` dispatch + usage string |
| `.claude-plugin/commands/lcm-sensitive.md` | **Create** | Slash command teaching LLM about `lcm sensitive` |
| `docs/privacy.md` | **Create** | Full data handling policy |
| `README.md` | **Modify** | Add Privacy section linking to docs/privacy.md |
| `test/scrub.test.ts` | **Create** | Unit tests for ScrubEngine |
| `test/sensitive.test.ts` | **Create** | Unit tests for handleSensitive |
| `test/daemon/routes/ingest.test.ts` | **Modify** | Add scrubbing integration test |
| `test/daemon/routes/compact.test.ts` | **Modify** | Add scrubbing integration test for inline ingest block |

---

## Task 1: DaemonConfig schema — add `security` field

**Files:**
- Modify: `src/daemon/config.ts`
- Modify: `test/daemon/config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/daemon/config.test.ts`, add:

```typescript
it("defaults security.sensitivePatterns to empty array", () => {
  const config = loadDaemonConfig("/nonexistent/config.json");
  expect(config.security).toEqual({ sensitivePatterns: [] });
});

it("merges user-defined sensitivePatterns from config file", () => {
  const tmp = writeTempConfig({ security: { sensitivePatterns: ["MY_TOKEN_.*"] } });
  const config = loadDaemonConfig(tmp);
  expect(config.security.sensitivePatterns).toEqual(["MY_TOKEN_.*"]);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/daemon/config.test.ts
```
Expected: FAIL — `config.security` is undefined

- [ ] **Step 3: Add SecurityConfig to `src/daemon/config.ts`**

Add after existing imports, before `DaemonConfig`:

```typescript
export interface SecurityConfig {
  /** User-defined global regex patterns (plain strings, no /.../ delimiters). */
  sensitivePatterns: string[];
}
```

Add `security: SecurityConfig` to `DaemonConfig` type, and add to `DEFAULTS`:

```typescript
security: {
  sensitivePatterns: [],
},
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run test/daemon/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/config.ts test/daemon/config.test.ts
git commit -m "feat(security): add security.sensitivePatterns to DaemonConfig"
```

---

## Task 2: ScrubEngine — `src/scrub.ts`

**Files:**
- Create: `src/scrub.ts`
- Create: `test/scrub.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/scrub.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ScrubEngine } from "../src/scrub.js";

describe("ScrubEngine — built-in patterns", () => {
  const engine = new ScrubEngine([], []);

  it("redacts OpenAI keys (sk-...)", () => {
    expect(engine.scrub("key=sk-abcdefghijklmnopqrstu")).toContain("[REDACTED]");
  });

  it("redacts Anthropic keys (sk-ant-...)", () => {
    expect(engine.scrub("key=sk-ant-api03-" + "a".repeat(40))).toContain("[REDACTED]");
  });

  it("redacts GitHub PATs (ghp_...)", () => {
    expect(engine.scrub("token=ghp_" + "A".repeat(36))).toContain("[REDACTED]");
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    expect(engine.scrub("aws_access_key_id=AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(engine.scrub("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9")).toContain("[REDACTED]");
  });

  it("redacts PEM key headers", () => {
    expect(engine.scrub("-----BEGIN RSA KEY-----")).toContain("[REDACTED]");
  });

  it("does not redact normal text", () => {
    const text = "Hello world, this is safe content.";
    expect(engine.scrub(text)).toBe(text);
  });
});

describe("ScrubEngine — custom patterns", () => {
  it("applies user-defined global patterns", () => {
    const engine = new ScrubEngine(["MY_TOKEN_[A-Z0-9]+"], []);
    expect(engine.scrub("token=MY_TOKEN_ABC123")).toContain("[REDACTED]");
  });

  it("applies per-project patterns", () => {
    const engine = new ScrubEngine([], ["PROJ_SECRET_[A-Z]+"]);
    expect(engine.scrub("secret=PROJ_SECRET_XYZ")).toContain("[REDACTED]");
  });

  it("global patterns precede project patterns (merge order)", () => {
    const engine = new ScrubEngine(["GLOBAL_.*"], ["LOCAL_.*"]);
    expect(engine.scrub("GLOBAL_123 and LOCAL_456")).toBe("[REDACTED] and [REDACTED]");
  });

  it("warns and skips invalid regex patterns, continues scrubbing valid ones", () => {
    const engine = new ScrubEngine(["[invalid"], ["VALID_[A-Z]+"]);
    expect(engine.scrub("VALID_ABC")).toContain("[REDACTED]");
    expect(engine.invalidPatterns).toContain("[invalid");
  });
});

describe("ScrubEngine.loadProjectPatterns", () => {
  it("parses patterns file, ignoring comment lines and blanks", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(tmpdir(), "sensitive-patterns-test.txt");
    await writeFile(file, "# comment\nMY_PAT\n\n# another comment\nSECRET_KEY\n");
    const patterns = await ScrubEngine.loadProjectPatterns(file);
    expect(patterns).toEqual(["MY_PAT", "SECRET_KEY"]);
  });

  it("returns empty array when file does not exist", async () => {
    const patterns = await ScrubEngine.loadProjectPatterns("/nonexistent/path.txt");
    expect(patterns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/scrub.test.ts
```
Expected: FAIL — `ScrubEngine` not found

- [ ] **Step 3: Implement `src/scrub.ts`**

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const BUILT_IN_PATTERNS: string[] = [
  "sk-[A-Za-z0-9]{20,}",
  "sk-ant-[A-Za-z0-9\\-]{40,}",
  "ghp_[A-Za-z0-9]{36}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN .* KEY-----",
  "Bearer [A-Za-z0-9\\-._~+/]+=*",
  "[Pp]assword\\s*[:=]\\s*\\S+",
];

export class ScrubEngine {
  private readonly compiled: Array<{ source: string; regex: RegExp }> = [];
  readonly invalidPatterns: string[] = [];

  constructor(globalPatterns: string[], projectPatterns: string[]) {
    const all = [...BUILT_IN_PATTERNS, ...globalPatterns, ...projectPatterns];
    for (const source of all) {
      try {
        this.compiled.push({ source, regex: new RegExp(source, "g") });
      } catch {
        this.invalidPatterns.push(source);
      }
    }
  }

  /** Redact all matching patterns in text, replacing matches with [REDACTED]. */
  scrub(text: string): string {
    let result = text;
    for (const { regex } of this.compiled) {
      regex.lastIndex = 0; // reset stateful global regex
      result = result.replace(regex, "[REDACTED]");
    }
    return result;
  }

  /** Parse a sensitive-patterns.txt file. Returns empty array if file is absent. */
  static async loadProjectPatterns(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  /** Build a ScrubEngine for a given project directory. */
  static async forProject(
    globalPatterns: string[],
    projectDir: string,
  ): Promise<ScrubEngine> {
    const projectPatterns = await ScrubEngine.loadProjectPatterns(
      join(projectDir, "sensitive-patterns.txt"),
    );
    return new ScrubEngine(globalPatterns, projectPatterns);
  }
}
```

- [ ] **Step 4: Run to confirm all tests pass**

```bash
npx vitest run test/scrub.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/scrub.ts test/scrub.test.ts
git commit -m "feat(security): add ScrubEngine with built-in and custom pattern support"
```

---

## Task 3: Integrate scrubbing into ingest route

**Files:**
- Modify: `src/daemon/routes/ingest.ts`
- Modify: `test/daemon/routes/ingest.test.ts`

**Context:** `createIngestHandler(config)` is in `src/daemon/routes/ingest.ts`. At line 78, `conversationStore.createMessagesBulk(inputs)` is called. Scrub each message's `content` field before this call. The project directory is obtained from `ensureProjectDir(cwd)` which is already called earlier in the handler.

- [ ] **Step 1: Write the failing test**

In `test/daemon/routes/ingest.test.ts`, following the existing mock pattern, add:

```typescript
it("scrubs secrets from message content before storing", async () => {
  const secret = "ghp_" + "A".repeat(36);
  // Send a message containing the secret through the handler
  // Mock createMessagesBulk and assert it was called with [REDACTED] not the raw secret
  // Follow the existing test setup pattern in this file
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/daemon/routes/ingest.test.ts
```

- [ ] **Step 3: Integrate ScrubEngine into `createIngestHandler`**

In `src/daemon/routes/ingest.ts`:

1. Add import at top: `import { ScrubEngine } from "../../scrub.js";`
2. The handler already calls `ensureProjectDir(cwd)` — use the returned path as `projectDir`
3. Before calling `createMessagesBulk(inputs)`, add:

```typescript
const scrubber = await ScrubEngine.forProject(
  config.security.sensitivePatterns,
  projectDir,
);
const scrubbedInputs = inputs.map((msg) => ({
  ...msg,
  content: scrubber.scrub(msg.content ?? ""),
}));
const records = await conversationStore.createMessagesBulk(scrubbedInputs);
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run test/daemon/routes/ingest.test.ts
```

- [ ] **Step 5: Run full suite**

```bash
npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/ingest.ts test/daemon/routes/ingest.test.ts
git commit -m "feat(security): scrub secrets in ingest route before SQLite write"
```

---

## Task 4: Integrate scrubbing into compact route inline ingest

**Files:**
- Modify: `src/daemon/routes/compact.ts`
- Modify: `test/daemon/routes/compact.test.ts`

**Context:** `createCompactHandler()` in `src/daemon/routes/compact.ts` has an inline ingest block at line 176 that calls `conversationStore.createMessagesBulk(inputs)` independently of the ingest handler. Apply the same scrubbing pattern. The project directory is available as `ensureProjectDir(cwd)` earlier in the same handler.

- [ ] **Step 1: Write the failing test**

In `test/daemon/routes/compact.test.ts`, add a test that sends a compact request with a message containing `AKIA` + 16 chars (AWS key), then asserts that the inline `createMessagesBulk` mock was called with `[REDACTED]` in the content field. Follow the existing mock setup in this test file.

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/daemon/routes/compact.test.ts
```

- [ ] **Step 3: Add scrubbing to the inline ingest block**

In `src/daemon/routes/compact.ts`, at the inline ingest block near line 176:

1. Add import: `import { ScrubEngine } from "../../scrub.js";`
2. Before `conversationStore.createMessagesBulk(inputs)`:

```typescript
const scrubber = await ScrubEngine.forProject(
  config.security.sensitivePatterns,
  projectDir, // already available from ensureProjectDir(cwd) above
);
const scrubbedInputs = inputs.map((msg) => ({
  ...msg,
  content: scrubber.scrub(msg.content ?? ""),
}));
const records = await conversationStore.createMessagesBulk(scrubbedInputs);
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run test/daemon/routes/compact.test.ts
```

- [ ] **Step 5: Run full suite**

```bash
npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/compact.ts test/daemon/routes/compact.test.ts
git commit -m "feat(security): scrub secrets in compact route inline ingest block"
```

---

## Task 5: Integrate scrubbing into CompactionEngine LLM passes

**Files:**
- Modify: `src/compaction.ts`
- Modify: nearest test file covering `leafPass` (search for `leafPass` or `CompactionEngine` in `test/`)

**Context:**
- `leafPass()` at ~line 1002: builds `concatenated` from raw message content at ~line 1026, then passes it to `summarizeWithEscalation()` at ~line 1032. Scrub `concatenated` before that call.
- `condensedPass()` at ~line 1093: builds `concatenated` from summary records at ~line 1111, then passes it to `summarizeWithEscalation()` at ~line 1127. Scrub `concatenated` before that call.
- Both use the same variable name: `concatenated`.

Add `scrubber?: ScrubEngine` to the `CompactionEngine` constructor options. Apply it in both passes.

- [ ] **Step 1: Write the failing test**

Add a test where a message contains a GitHub PAT, verify the `summarize` mock is called with `[REDACTED]` instead of the real token:

```typescript
it("scrubs secrets from message content before sending to LLM in leafPass", async () => {
  const secret = "ghp_" + "A".repeat(36);
  // Create engine with a scrubber
  // Feed a message containing the secret
  // Assert summarize was called with [REDACTED] not the raw secret
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/compaction.test.ts  # or whichever file covers leafPass
```

- [ ] **Step 3: Add scrubber to CompactionEngine constructor**

In `src/compaction.ts`, find the constructor options interface (it accepts `config`, `summaryStore`, etc.) and add:

```typescript
scrubber?: ScrubEngine;
```

Store as `private readonly scrubber?: ScrubEngine`.

- [ ] **Step 4: Apply scrubber in `leafPass()` (~line 1026)**

After building `concatenated`, add:

```typescript
const safeText = this.scrubber ? this.scrubber.scrub(concatenated) : concatenated;
```

Then pass `safeText` to `summarizeWithEscalation()` instead of `concatenated`.

- [ ] **Step 5: Apply scrubber in `condensedPass()` (~line 1111)**

Same pattern — after building `concatenated` from summary records:

```typescript
const safeText = this.scrubber ? this.scrubber.scrub(concatenated) : concatenated;
```

Pass `safeText` to `summarizeWithEscalation()`.

- [ ] **Step 6: Wire scrubber into compact route**

In `src/daemon/routes/compact.ts`, pass the `scrubber` (already constructed in Task 4) when instantiating `CompactionEngine`:

```typescript
new CompactionEngine({ ..., scrubber })
```

- [ ] **Step 7: Run to confirm pass**

```bash
npx vitest run
```

- [ ] **Step 8: Commit**

```bash
git add src/compaction.ts src/daemon/routes/compact.ts
git commit -m "feat(security): scrub secrets from LLM chunk in leafPass and condensedPass"
```

---

## Task 6: `lcm sensitive` CLI — `src/sensitive.ts`

**Files:**
- Create: `src/sensitive.ts`
- Modify: `bin/lcm.ts`
- Create: `test/sensitive.test.ts`

**Important:** Use `projectId()` from `src/daemon/project.ts` for the hash — do NOT reimplement SHA256. Import it at the top of `sensitive.ts`:

```typescript
import { projectId, projectDir as getProjectDir } from "./daemon/project.js";
```

Check `src/daemon/project.ts` to confirm the export names before writing the import.

- [ ] **Step 1: Write failing tests**

Create `test/sensitive.test.ts` — use real tmp directories for filesystem operations:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join, tmpdir } from "node:path";
// import the individual handler functions (or handleSensitive with args array)

describe("lcm sensitive add", () => {
  it("appends pattern to project sensitive-patterns.txt", async () => { ... });
  it("is idempotent — does not duplicate existing pattern", async () => { ... });
});

describe("lcm sensitive remove", () => {
  it("removes exact-match pattern from project file", async () => { ... });
  it("exits with error when pattern not found", async () => { ... });
});

describe("lcm sensitive test", () => {
  it("returns redacted output when pattern matches", async () => { ... });
  it("returns clean message when no pattern matches", async () => { ... });
});

describe("lcm sensitive purge", () => {
  it("deletes project dir when --yes passed", async () => { ... });
  it("exits with error when --yes not passed", async () => { ... });
  it("deletes all projects when --all --yes passed", async () => { ... });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/sensitive.test.ts
```

- [ ] **Step 3: Implement `src/sensitive.ts`**

Top-level imports (all ESM — no `require()`):

```typescript
import { readFile, writeFile, rm, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ScrubEngine, BUILT_IN_PATTERNS } from "./scrub.js";
import { loadDaemonConfig } from "./daemon/config.js";
import { projectId, projectDir as getProjectDir } from "./daemon/project.js";
```

Implement `handleSensitive(args: string[])` dispatching to `sensitiveList()`, `sensitiveAdd()`, `sensitiveRemove()`, `sensitiveTest()`, `sensitivePurge()`.

Key points:
- `lcm sensitive purge` requires `--yes` flag; exit with error message if absent
- `lcm sensitive remove` requires exact string match; `console.error` + `process.exit(1)` if not found
- `lcm sensitive add` checks for duplicate before appending

- [ ] **Step 4: Add `case "sensitive":` to `bin/lcm.ts`**

```typescript
case "sensitive": {
  const { handleSensitive } = await import("../src/sensitive.js");
  await handleSensitive(args.slice(1));
  break;
}
```

Also add `sensitive` to the usage string.

- [ ] **Step 5: Run to confirm pass**

```bash
npx vitest run test/sensitive.test.ts
```

- [ ] **Step 6: Run full suite**

```bash
npx vitest run
```

- [ ] **Step 7: Build and manual smoke test**

```bash
npm run build && npm link
lcm sensitive list
lcm sensitive add "TEST_TOKEN_[A-Z]+"
lcm sensitive test "token=TEST_TOKEN_ABC"
# Expected: Redacted: token=[REDACTED]
lcm sensitive remove "TEST_TOKEN_[A-Z]+"
```

- [ ] **Step 8: Commit**

```bash
git add src/sensitive.ts bin/lcm.ts test/sensitive.test.ts dist/
git commit -m "feat(security): add lcm sensitive CLI (list/add/remove/test/purge)"
```

---

## Task 7: `lcm doctor` — Security section

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `test/doctor/doctor.test.ts`

- [ ] **Step 1: Write failing tests**

Add three tests:
1. No `sensitive-patterns.txt` → security section shows `⚠️  project patterns   none configured`
2. Valid patterns file → shows `✅  project patterns   2 active`
3. Invalid regex in patterns file → shows failure mentioning the bad pattern

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/doctor/doctor.test.ts
```

- [ ] **Step 3: Add Security section to `src/doctor/doctor.ts`**

Import at top: `import { ScrubEngine, BUILT_IN_PATTERNS } from "../scrub.js";`

After the existing MCP check, add:

```typescript
// ── Security ──────────────────────────────────────
const projectPatterns = await ScrubEngine.loadProjectPatterns(
  join(projectDir, "sensitive-patterns.txt"),
);
const tempEngine = new ScrubEngine(config.security.sensitivePatterns, projectPatterns);

section("Security");
pass("built-in patterns", `${BUILT_IN_PATTERNS.length} active`);
if (projectPatterns.length === 0) {
  warn("project patterns", "none configured");
  hint("Run: lcm sensitive add \"<pattern>\" to protect project-specific secrets");
} else {
  pass("project patterns", `${projectPatterns.length} active`);
}
if (tempEngine.invalidPatterns.length > 0) {
  fail("invalid regex patterns", tempEngine.invalidPatterns.join(", "));
  hint("Fix or remove from: " + join(projectDir, "sensitive-patterns.txt"));
}
```

Match the exact `section()`, `pass()`, `warn()`, `fail()`, `hint()` helper pattern used elsewhere in `doctor.ts`.

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run test/doctor/doctor.test.ts
```

- [ ] **Step 5: Smoke test**

```bash
npm run build && npm link && lcm doctor
```
Expected: Security section visible with 7 built-in patterns, ⚠️ on project patterns.

- [ ] **Step 6: Commit**

```bash
git add src/doctor/doctor.ts test/doctor/doctor.test.ts dist/
git commit -m "feat(security): add Security section to lcm doctor output"
```

---

## Task 8: `lcm sensitive` Claude Code command

**Files:**
- Create: `.claude-plugin/commands/lcm-sensitive.md`

- [ ] **Step 1: Create the command file**

```markdown
---
description: Manage sensitive patterns — scrub secrets from lossless-claude storage and LLM calls
allowed-tools: Bash
---

# lcm sensitive — Secrets & Privacy Management

Manage which patterns lossless-claude scrubs before storing or summarizing conversations.

## Quick Reference

\`\`\`bash
lcm sensitive list                        # show all active patterns
lcm sensitive add "MY_TOKEN_[A-Z0-9]+"   # add pattern for this project
lcm sensitive add --global "ORG_KEY_.*"  # add to global config (all projects)
lcm sensitive remove "pattern"            # remove from project patterns
lcm sensitive test "my string"            # dry-run: what gets redacted?
lcm sensitive purge --yes                 # delete all stored data for this project
lcm sensitive purge --all --yes           # delete all lossless-claude project data
\`\`\`

## Pattern Format

Plain regex strings — no \`/\` delimiters, no flags.
Case-insensitive: use \`(?i)\` inline flag: \`(?i)my_token\`

## Storage locations

- Global patterns: \`~/.lossless-claude/config.json\` → \`security.sensitivePatterns\`
- Project patterns: \`~/.lossless-claude/projects/{hash}/sensitive-patterns.txt\`

See \`docs/privacy.md\` for the full data handling policy.
```

- [ ] **Step 2: Commit**

```bash
git add .claude-plugin/commands/lcm-sensitive.md
git commit -m "docs(security): add lcm-sensitive slash command for Claude Code"
```

---

## Task 9: Privacy documentation

**Files:**
- Create: `docs/privacy.md`
- Modify: `README.md`

- [ ] **Step 1: Create `docs/privacy.md`**

Cover (per spec's Documentation section):
- What is stored and where (`~/.lossless-claude/projects/{hash}/db.sqlite`)
- What leaves the machine — default `claude-process` is local subprocess; optional OpenAI/Anthropic providers send data over the network
- What is never stored externally by lcm (raw messages, tool results — only summaries from LLM calls)
- How scrubbing works (built-in defaults + custom patterns applied before storage and before LLM)
- How to add custom patterns (`lcm sensitive add`)
- Data retention (no automatic expiry; user-controlled deletion)
- How to delete data (`lcm sensitive purge`)
- How to opt out entirely (`lcm uninstall` + `lcm sensitive purge --all`)
- **Known v1 limitations:** PEM body not redacted (header only), `PASSWORD=` env-style not matched, no retroactive scrubbing of existing data

- [ ] **Step 2: Add Privacy section to README.md**

```markdown
## Privacy

Conversation data is stored locally in `~/.lossless-claude/` and never sent to external servers by lcm. When summarizing, conversation chunks are sent to your configured LLM — by default the local `claude` CLI subprocess (same process as Claude Code). Built-in redaction scrubs common secret patterns (API keys, tokens, passwords) before storage or summarization.

See [docs/privacy.md](docs/privacy.md) for the full data handling policy, how to add custom patterns, and how to delete stored data.
```

- [ ] **Step 3: Commit**

```bash
git add docs/privacy.md README.md
git commit -m "docs(security): add privacy.md and README privacy section"
```

---

## Task 10: Final verification

- [ ] **Run full test suite**

```bash
npx vitest run
```
Expected: all tests pass (no regressions)

- [ ] **Rebuild and reinstall**

```bash
npm run build && npm link
```

- [ ] **Sync plugin cache**

```bash
CACHE=$(ls -d ~/.claude/plugins/cache/*/lossless-claude/*/ 2>/dev/null | head -1)
if [ -n "$CACHE" ]; then
  rm -rf "$CACHE" && mkdir -p "$CACHE"
  cp .claude-plugin/plugin.json "$CACHE/"
  cp -r .claude-plugin/commands "$CACHE/"
  cp -r .claude-plugin/hooks "$CACHE/"
fi
```

Then run `/reload-plugins` in Claude Code.

- [ ] **Run `lcm doctor`** — must show Security section with 0 failures

- [ ] **End-to-end smoke test**

```bash
lcm sensitive add "E2E_SECRET_[A-Z]+"
lcm sensitive list
lcm sensitive test "token=E2E_SECRET_XYZ"
# Expected: Redacted: token=[REDACTED]
lcm sensitive remove "E2E_SECRET_[A-Z]+"
```

- [ ] **Push and open PR**

```bash
git push origin <branch>
gh pr create --title "feat: security & privacy — secrets scrubbing, lcm sensitive CLI, docs" --base develop
```
