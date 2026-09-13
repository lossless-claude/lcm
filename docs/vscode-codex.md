# VS Code and Codex setup

Codex uses native lifecycle hooks for automatic memory capture and recall. GitHub Copilot in VS Code uses a skill-based connector with the same LCM backend.

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

This writes a repo-local skill file at `.agents/skills/lcm-memory/SKILL.md`. Codex and Copilot both read that directory.

## Install the Codex connector

`lcm install` sets up every harness on the machine: when `codex` is on PATH it
installs the LCM hooks globally in `~/.codex/hooks.json`, the same as
`lcm connectors install codex --global`, and reports one outcome per harness.
`lcm install --dry-run` previews it without writing anything. Codex keeps the
npm CLI: the installed hooks name the absolute node and `lcm` paths, so nothing
depends on PATH at session time.

For Codex in the current repository only:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

This merges LCM command hooks into `.codex/hooks.json`, preserving unrelated hooks. Use `--global` to install in `~/.codex/hooks.json` instead. Reinstalling updates the LCM handlers without duplicating them; `lcm connectors remove codex` removes only those handlers.

Review the installed hooks with Codex's `/hooks` interface and trust them before expecting automatic capture. Codex can skip untrusted or disabled hooks. `doctor` verifies the installed configuration and reports activation as unknown; it does not claim that installing a file activates it.

The installed hooks call the resolved LCM executable independently of the session working directory:

| Codex event | LCM behavior |
| --- | --- |
| `SessionStart` | Capture pending transcript content and restore memory on startup, resume, clear, or compact. |
| `UserPromptSubmit` | Capture pending content and inject bounded relevant promoted and episodic memory. |
| `Stop` | Capture new user/assistant messages after each completed turn. |
| `Interrupt` | Attempt a short capture without starting the daemon. |
| `SessionEnd` | Attempt a short final capture without starting the daemon. |
| `PreCompact` | Capture first, then compact LCM memory; native Codex compaction continues normally. |

After compaction, `SessionStart` with source `compact` restores LCM memory. No additional `PostCompact` handler is installed, so the two events cannot inject duplicate context. Hook failures do not block Codex. Interrupted or missed writes are retried when a subsequent lifecycle event reads the transcript. A valid record still being written is deferred until its newline arrives; historical imports can consume a complete final record without a newline.

On resume after automatic compaction, Codex can emit both `SessionStart(resume)` and `SessionStart(compact)`. LCM avoids repeating identical memory only when the transcript proves that a developer message already contains it after the latest compaction. If a new compaction occurred or that evidence is absent, LCM restores normally.

Malformed completed records, unreadable files, and mismatched session/project metadata produce ingestion errors rather than successful empty imports. Hooks report these failures on stderr and allow the Codex operation to continue. Ingestion and compaction share the project write queue.

Live ingestion uses a byte cursor persisted in SQLite with the newly captured messages. Subsequent events read only appended bytes and a bounded metadata header, using asynchronous file reads. Restarts reuse the checkpoint; missing or invalid checkpoints trigger recovery scans. The context-deduplication check also uses a bounded tail read instead of loading the complete rollout.

Codex uses its own transcript parser and instruction lifecycle. LCM does not capture or replay `CLAUDE.md` into Codex. New sessions restore recent project context; resumed sessions restore their own context. Memory output is bounded, and full captured history remains searchable through `lcm search` and `lcm grep`.

Optional guidance-only installation remains available with `lcm connectors install codex --type skill`. MCP is optional and its TOML configuration remains manual.

To import existing Codex sessions into LCM:

```bash
lcm import --codex
lcm import --replay --dry-run
lcm import --replay
```

`lcm import --replay` discovers both Claude and Codex sessions by default, including archived Codex sessions. Select one source explicitly with `--provider claude` or `--provider codex`. See [import behavior](import.md) for project selection and replay progress.

## Runtime requirements and limits

Use a Codex runtime that supports the events and command-hook schema in the [official hooks reference](https://developers.openai.com/codex/hooks). Hook trust and feature enablement belong to Codex. Local CLI hook support does not prove support in a hosted App; desktop and hosted clients must be validated separately before claiming native activation there.

The opt-in native runtime test verifies startup, resume, prompt, stop, automatic compaction, and transcript timing with Codex CLI 0.153.4 and a local mock provider. See [verification details](codex-parity.md#verification-contract).

## Remaining connector gaps

1. `lcm install` sets up Claude Code and Codex. It does not set up VS Code.
2. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
3. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
4. Codex MCP config lives in `.codex/config.toml`, but the connector installer does not edit TOML yet. `lcm connectors install codex --type mcp` only prints manual instructions.
