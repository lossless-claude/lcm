---
name: lcm-context
description: "Use before starting work in this repository to recall project memory with the lcm CLI, and when a durable insight should be stored. Covers lcm search, grep, describe, expand and store."
---

# lcm memory from the CLI

lcm keeps memory across sessions. This skill is the CLI form for agents whose host does not
load the plugin. MCP parameters are in [docs/agent-tools.md](../../../docs/agent-tools.md); tags are in
[docs/tag-schema.md](../../../docs/tag-schema.md). `lcm <command> --help` is the option reference.

## When to recall

If the host injected memory at session start (the Claude Code plugin and the Codex hooks
both do), do not query for what was injected. Otherwise, search before the first code
change, and whenever the context lacks something a past session may hold.

## Recall

```bash
lcm search "how was auth implemented"                       # broad, both layers
lcm search "compaction" --tag type:decision --layer promoted  # filter by tag and layer
lcm grep "socket.unref"                                      # exact keyword or regex
lcm describe <nodeId>                                        # metadata before expanding
lcm expand <nodeId> --depth 2                                # source content of a summary
```

`--tag` and `--layer` repeat; layers are `episodic` and `promoted`.

## Store

One concise insight and its why per store, tagged with `type:` and `project:` or `scope:`.
Do not store what git, the docs or the instruction files already hold.

```bash
lcm store "SessionEnd only fires on a graceful exit, so a crashed session loses its tail." --tag type:gotcha --tag scope:lcm
```

## When something fails

| Symptom | Do |
|---|---|
| `lcm` not found | `npm install -g @lossless-claude/lcm` |
| daemon not running | `lcm daemon start --detach`, retry |
| no results | `lcm grep` with a different term, or broaden the query |
| anything else | `lcm doctor` |
