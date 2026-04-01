# VS Code and Codex setup

This repository already has the shared memory backend needed for VS Code and Codex, but those integrations are not as automated as the Claude Code plugin path.

## Install from a repo checkout

If you are working from this repository directly instead of the published npm package:

```bash
npm install
npm run build
chmod +x dist/bin/lcm.js
npm link
```

If you do not want a global link, run `node dist/bin/lcm.js ...` instead of `lcm ...` in the commands below.

## Install the VS Code connector

For GitHub Copilot in VS Code:

```bash
lcm connectors install github-copilot
lcm connectors doctor github-copilot
```

This writes a repo-local skill file at `.github/skills/lcm-memory/SKILL.md`.

## Install the Codex connector

For Codex in the current repository:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

This writes a repo-local skill file at `.codex/skills/lcm-memory/SKILL.md`.

To import existing Codex sessions into LCM:

```bash
lcm import --codex
```

## Current shortcomings

1. `lcm install` is still Claude-Code-specific. It does not set up VS Code or Codex.
2. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
3. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
4. Codex MCP config lives in `.codex/config.toml`, but the connector installer does not edit TOML yet. `lcm connectors install codex --type mcp` only prints manual instructions.
5. Codex has transcript import and can be used as a summarizer provider, but it does not have Claude-style live turn capture and hook orchestration.
6. The top-level branding and install flow were originally Claude-first, so documentation drift is still a risk whenever new clients are added.

## Improvement candidates

1. Add first-class `lcm setup vscode` and `lcm setup codex` commands instead of overloading `lcm install`.
2. Add TOML read/write support so Codex MCP setup can be automated.
3. Add a real VS Code/Codex runtime adapter for restore, writeback, and prompt-time recall instead of skill-only guidance.
4. Add connector tests that exercise GitHub Copilot and Codex default install flows explicitly.