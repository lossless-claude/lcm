# Copilot MCP setup — code review and cloud agent

This file is **documentation, not configuration**. GitHub does not read it.

Copilot's MCP configuration lives in repository settings, not in the repo, so it cannot be version-controlled, reviewed in a pull request, or tested on a branch. This file exists so the configuration that *is* live has something in the repo to be checked against.

## One-time setup

**Settings → Copilot → MCP servers** (sidebar, under "Code, planning, and automation"), paste into the "MCP configuration" section and click **Save MCP configuration** — the JSON is validated on save:

```json
{
  "mcpServers": {
    "codebase-memory": {
      "type": "local",
      "command": "/home/runner/.local/bin/codebase-memory-mcp",
      "args": [],
      "tools": [
        "list_projects",
        "index_status",
        "check_index_coverage",
        "get_architecture",
        "search_graph",
        "trace_path",
        "get_code_snippet",
        "query_graph",
        "get_graph_schema",
        "search_code",
        "detect_changes"
      ]
    }
  }
}
```

Then confirm **Settings → Copilot → Code review → Allow Copilot to use MCP tools when reviewing pull requests** is enabled. It is on by default, and it lives on a different page from the MCP configuration above.

The GitHub and Playwright MCP servers are enabled by default; the block above is added alongside them, not instead of them.

> **Copilot uses these tools autonomously and will not ask for approval first.** That is why the `tools` list below is read-only — GitHub's own guidance is to allowlist specific read-only tools rather than `"*"`.

## How the pieces fit

| Piece | Where it lives | What it does |
|---|---|---|
| `.github/workflows/copilot-setup-steps.yml` | this repo | installs the pinned binary at `/home/runner/.local/bin/` and indexes the checkout, so the graph exists before either agent starts |
| the JSON above | repo settings | registers the binary as a local stdio MCP server and declares which tools Copilot may call |
| `.github/skills/code-review/SKILL.md` | this repo | tells the **reviewer** to actually use it — per GitHub's docs, it is *more likely* to reach for MCP context when a skill says so explicitly |
| `.github/copilot-instructions.md` | this repo | tells the **cloud agent** the same, plus: verify each review finding against the graph before reporting it fixed |

The tool list is read-only on purpose: `index_repository`, `manage_adr`, `ingest_traces` and `delete_project` are omitted so neither agent can mutate the graph. Indexing is the workflow's job.

## Why MCP and not the CLI

The CLI would be preferable — it would live entirely in the repo, be reviewable in a PR, and testable on a branch. But GitHub documents the reviewer's agentic surface as *full project context gathering* and *passing suggestions to the cloud agent*, with tool use defined as MCP servers plus agent skills. There is no documented way for a review to run a shell command, so there is nowhere for a CLI call to execute.

## One workflow, both agents

The MCP registration is shared by Copilot code review and Copilot cloud agent, but the *environment* is not — each reads its own workflow file. GitHub resolves it like this:

- `copilot-setup-steps.yml` — used by the cloud agent, **and by code review when `copilot-code-review.yml` is absent**.
- `copilot-code-review.yml` — used by code review instead, when present.

So this repo deliberately keeps **only `copilot-setup-steps.yml`**. Both agents get the same binary and the same index, and there is no second file to forget when the version is bumped. Add `copilot-code-review.yml` only if the two ever genuinely need different environments.

Giving the cloud agent the graph is arguably the more valuable half. On #302 it reported four Codex findings as fixed that were still open on the next round — the kind of thing `trace_path` exists to catch. `.github/copilot-instructions.md` tells it to verify findings against the graph before claiming them closed.

## Verifying it works

**Code review** — after a review runs, in order of directness:

1. **Session logs** — open the review session from the pull request timeline (**View session**) and read the "Setting up environment" section. It lists which MCP servers and tools were started and called. This is the authoritative signal.
2. **Attributions** at the bottom of individual review comments name the MCP server or skill that produced them. Absence here only means that *comment* did not use it.

**Cloud agent** — assign an issue to Copilot, open the pull request it creates from the issue timeline, click **View session**, then expand the **Start MCP Servers** step. A successful start lists the server's tools at the bottom of that log.

If `codebase-memory` never appears, check in this order: the setup workflow succeeded, the `command` path in the JSON matches where the workflow installed the binary (`/home/runner/.local/bin/`), and — for reviews specifically — that MCP tools are enabled for code review.

## Keeping the version honest

`CBM_VERSION` in the workflow is pinned. Bumping it is a normal PR. An unpinned `latest` would change both agents' environment with no commit to point at, which is exactly the kind of silent drift the review rules elsewhere in this repo exist to prevent.
