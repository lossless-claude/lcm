# lcm-context Skill Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the lcm-context skill for Claude Code (global install via `lcm install`) and upgrade the universal skill template for all other platforms.

**Architecture:** Replace the existing skill template (`src/connectors/templates/skill/SKILL.md`) with the improved universal variant. Add a Claude Code-specific variant to `src/connectors/configs/claude-code/`. Wire `lcm install` to write the Claude Code skill globally to `~/.claude/skills/lcm-context/`. Sync `.agents/skills/` with the upgraded template.

**Tech Stack:** TypeScript, Vitest, existing connector registry + template-service

**Spec:** `.xgh/specs/2026-03-23-lcm-context-skill-distribution-design.md`

**Scope:** Phase 1 — Claude Code global install + universal template upgrade. Phase 2 (deferred) covers per-platform install for Codex, Gemini, Cursor, OpenCode, Kiro, Zed with AGENTS.md append logic, `--platform` flag, and `instructionFile` connector config field.

---

### Task 1: Upgrade the Universal Skill Template

Replace the existing skill template with the improved version that includes chaining pattern, decision trees, error self-healing, and curation guardrails.

**Files:**
- Modify: `src/connectors/templates/skill/SKILL.md`

- [ ] **Step 1: Read the current template**

Verify the current content at `src/connectors/templates/skill/SKILL.md` matches the simpler version with basic decision table.

- [ ] **Step 2: Replace with improved universal variant**

Write the new template based on `.agents/skills/lcm-context/SKILL.md` (already written). Key additions vs. old template:
- "You MUST" trigger in description
- Retrieval chaining pattern (search → grep → describe → expand)
- "Use when / Do NOT use when" guardrails for retrieval and storage
- Error self-healing table (agent-fixable vs. user-fixable)
- CLI commands throughout (not MCP tool names)

Use `name: lcm-context` in frontmatter (consistent with spec and existing files).

```markdown
---
name: lcm-context
description: "You MUST use this before any work to recall project memory, and after implementing to store decisions. Lossless-claude (lcm) provides persistent cross-session memory via CLI commands."
---
```

Use the full content from `.agents/skills/lcm-context/SKILL.md` as the source.

- [ ] **Step 3: Verify template-service still loads it correctly**

Run: `npx vitest run test/connectors/ -t "skill" --reporter verbose`
Expected: existing skill-related tests pass (template loading, variable substitution).

- [ ] **Step 4: Commit**

```bash
git add src/connectors/templates/skill/SKILL.md
git commit -m "feat: upgrade universal skill template with decision trees, chaining, and error self-healing"
```

---

### Task 2: Create Claude Code Skill Config

Create a separate Claude Code variant in the configs directory (not `.claude-plugin/` — npm package needs a stable source path).

**Files:**
- Create: `src/connectors/configs/claude-code/SKILL.md`
- Verify: `.claude-plugin/skills/lcm-context/SKILL.md` (already exists, keep in sync)

- [ ] **Step 1: Create the configs directory**

```bash
mkdir -p src/connectors/configs/claude-code
```

- [ ] **Step 2: Write the Claude Code variant**

Copy content from `.claude-plugin/skills/lcm-context/SKILL.md` to `src/connectors/configs/claude-code/SKILL.md`. This is the canonical source for the installer. Confirm it has:
- `name: lcm-context` in frontmatter
- Description WITHOUT "You MUST" (complementary to hooks)
- MCP tool names (lcm_search, lcm_grep, etc.)
- "Hooks already inject memory" note
- Chaining pattern, error self-healing, curation guidance

- [ ] **Step 3: Verify both files match**

```bash
diff .claude-plugin/skills/lcm-context/SKILL.md src/connectors/configs/claude-code/SKILL.md
```

Expected: identical content.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/configs/claude-code/SKILL.md
git commit -m "feat: add Claude Code skill config as installer source"
```

---

### Task 3: Add Global Install Support for Claude Code

Add support for global install to `~/.claude/skills/lcm-context/` so the skill is available across all projects.

**Files:**
- Modify: `src/connectors/installer.ts`
- Modify: `src/connectors/types.ts`
- Create: `test/connectors/global-install.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { installConnector } from '../../src/connectors/installer.js';
import { readFileSync } from 'node:fs';

describe('global skill install', () => {
  it('resolves ~ paths for claude-code skill type', () => {
    const result = installConnector('claude-code', 'skill', { global: true });
    expect(result.path).toMatch(/^\/.*\.claude\/skills\/lcm-context/);
  });

  it('uses Claude Code variant content (MCP tool names, no You MUST)', () => {
    const result = installConnector('claude-code', 'skill', { global: true });
    expect(result.success).toBe(true);
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('lcm_search');
    expect(content).toContain('Hooks already inject memory');
    expect(content).not.toContain('You MUST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/connectors/global-install.test.ts --reporter verbose`
Expected: FAIL — `global` option not yet supported.

- [ ] **Step 3: Add `global` option to InstallOptions type**

In `src/connectors/types.ts`, add to the install options:

```typescript
export interface InstallOptions {
  // ... existing fields
  global?: boolean;  // Install to user-level config instead of project-level
}
```

- [ ] **Step 4: Implement global path resolution in installer.ts**

In `src/connectors/installer.ts`, modify `resolveConfigPath()`:
- If `options.global` is true and agent is `claude-code` and type is `skill`:
  - Resolve to `~/.claude/skills/lcm-context/SKILL.md` instead of `.claude/skills/`
- For Claude Code global skill, read content from `src/connectors/configs/claude-code/SKILL.md` using the existing ESM pattern, e.g. `path.resolve(dirname(fileURLToPath(import.meta.url)), '../connectors/configs/claude-code/SKILL.md')` (consistent with how `doctor.ts` and `doctor.ts` resolve paths in the built package)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/connectors/global-install.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/connectors/types.ts src/connectors/installer.ts test/connectors/global-install.test.ts
git commit -m "feat: add global install support for Claude Code skill"
```

---

### Task 4: Wire Global Install into `lcm install` CLI Command

Make `lcm install` automatically install the skill globally for Claude Code (alongside hooks and MCP config it already writes).

**Files:**
- Modify: `src/cli/install.ts` (or wherever the CLI install command lives — check `bin/lcm.ts` first)
- Create: `test/cli/install-skill.test.ts`

- [ ] **Step 1: Find the CLI install command**

Check `src/cli/` or `bin/lcm.ts` for the install command handler. Note the exact file path.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

describe('lcm install includes skill', () => {
  it('writes global skill file alongside hooks and MCP', async () => {
    // Run the install flow (may need to mock filesystem for CI)
    // Assert ~/.claude/skills/lcm-context/SKILL.md was written
    // Assert content contains 'lcm_search' (Claude Code variant)
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/cli/install-skill.test.ts --reporter verbose`
Expected: FAIL

- [ ] **Step 4: Add skill install step to the CLI install flow**

After the existing hook/MCP install steps, add:
```typescript
// Install global skill for Claude Code
const skillResult = await installConnector('claude-code', 'skill', { global: true });
if (skillResult.success) {
  log(`Skill installed: ${skillResult.path}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cli/install-skill.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run --reporter verbose`
Expected: All tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/cli/install.ts test/cli/install-skill.test.ts
git commit -m "feat: lcm install writes global skill file for Claude Code"
```

---

### Task 5: Sync `.agents/skills/` with Upgraded Template

The `.agents/skills/lcm-context/SKILL.md` was written manually during brainstorming. Ensure it matches the upgraded template from Task 1 (both use CLI syntax, "You MUST" trigger, `name: lcm-context`).

**Files:**
- Modify: `.agents/skills/lcm-context/SKILL.md`

- [ ] **Step 1: Diff the two files**

```bash
diff .agents/skills/lcm-context/SKILL.md src/connectors/templates/skill/SKILL.md
```

Both should use CLI commands (not MCP tool names) and include the "You MUST" trigger. They are the universal variant.

- [ ] **Step 2: Sync if different**

Copy the template content to `.agents/skills/lcm-context/SKILL.md`.

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/lcm-context/SKILL.md
git commit -m "chore: sync .agents/ skill with upgraded template"
```

---

### Task 6: Update `lcm doctor` to Check Skill Installation

Add a skill presence check to the doctor diagnostics.

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `test/doctor/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('checks for global skill installation', async () => {
  const result = await runDoctor();
  const skillCheck = result.checks.find(c => c.name === 'skill');
  expect(skillCheck).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/doctor/doctor.test.ts -t "skill" --reporter verbose`
Expected: FAIL — no skill check exists.

- [ ] **Step 3: Add skill check to doctor**

In `src/doctor/doctor.ts`, add a check that:
- Looks for `~/.claude/skills/lcm-context/SKILL.md`
- Reports ✅ if found, ⚠️ with "Run: lcm install to add skill" if missing

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/doctor/doctor.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/doctor/doctor.ts test/doctor/doctor.test.ts
git commit -m "feat: lcm doctor checks for skill installation"
```

---

### Task 7: End-to-End Verification

- [ ] **Step 1: Build and link**

```bash
npm run build && chmod +x dist/bin/lcm.js && npm link
```

- [ ] **Step 2: Run lcm install and verify skill is written**

```bash
lcm install
ls ~/.claude/skills/lcm-context/SKILL.md
cat ~/.claude/skills/lcm-context/SKILL.md | head -5
```

Expected: File exists with `name: lcm-context` in frontmatter.

- [ ] **Step 3: Run lcm doctor and verify skill check**

```bash
lcm doctor
```

Expected: `skill` check shows ✅.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run --reporter verbose
```

Expected: All tests pass.

- [ ] **Step 5: Verify plugin skill loads in Claude Code**

Restart Claude Code session (not just `/reload-plugins` — new skills require a full restart). Check that `lcm-context` appears in skills list.

- [ ] **Step 6: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: e2e verification cleanup"
```

---

## Phase 2 (Deferred)

The following are described in the spec but deferred to a follow-up plan:

- [ ] **Per-platform config files:** Create `src/connectors/configs/{codex,gemini,cursor,opencode,kiro,zed}/` with platform-appropriate instruction files
- [ ] **`lcm install --platform <x>` flag:** CLI flag to target specific platforms
- [ ] **AGENTS.md idempotent append:** `<!-- lcm-context: start -->` / `<!-- lcm-context: end -->` delimiter logic for Codex, OpenCode, Zed
- [ ] **GEMINI.md:** Write routing file for Gemini CLI projects
- [ ] **Cursor .mdc rule:** Write `.cursor/rules/lcm-context.mdc`
- [ ] **`instructionFile` connector config field:** Add to `ConnectorConfig` interface in `src/connectors/types.ts` for per-platform instruction file metadata
- [ ] **Kiro KIRO.md:** Write instruction file for Kiro projects
