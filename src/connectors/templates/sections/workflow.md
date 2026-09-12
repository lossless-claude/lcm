# Workflow Instruction

You are a coding agent. Use the lcm CLI to manage persistent memory across sessions.

## Core Rules

- **Search first.** Before starting any code task, retrieve relevant context with `lcm search`.
- **Store durable insights.** Explicitly, with `lcm store`, tagged with `type:` — one concise insight and its why per store.

## When to Search

- Writing, editing, or modifying code in this project
- Understanding how something works in this codebase
- Debugging, fixing, or troubleshooting issues
- Before making architectural or design decisions

## When to Store

| Tag | Store when |
|-----|------------|
| `type:decision` | An architectural or design choice was made, with trade-offs |
| `type:preference` | The user stated a working style or tool preference |
| `type:root-cause` | A bug cause took effort to uncover |
| `type:pattern` | A codebase convention is documented nowhere else |
| `type:gotcha` | A non-obvious pitfall or footgun surfaced |
| `type:solution` | A non-trivial fix is worth remembering |
| `type:workflow` | A multi-step process worked |

## When to Skip

- General programming concepts (not codebase-specific)
- Meta tasks: run tests, build, commit, create PR
- Simple clarifications about a previous response

{{command_reference}}
