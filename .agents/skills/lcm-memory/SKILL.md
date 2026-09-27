---
name: lcm-memory
description: Search and store lcm memory with the lcm CLI. Use before a code task in this project, before asking the user about something a past session may have settled, and when a durable insight (decision, preference, root-cause, pattern, gotcha, solution, workflow) surfaces.
---

# lcm memory

## Core Rules

- Search memory before a code task in this project, and before asking the user about anything a past session may have settled.
- Store durable insights explicitly with `lcm store`, tagged with `type:`: one concise insight and its why per store.
- Skip both for general programming concepts, meta tasks (run tests, build, commit, open a PR), and clarifications about a previous response.

## Recall

- `lcm search`: broad recall across sessions ("how was X implemented", "the decision about Y")
- `lcm grep`: when you hold an exact keyword, error message or function name
- `lcm describe`: check a node's metadata before expanding it
- `lcm expand`: recover the detail a summary compressed away

## When to Store

| Tag | Store when |
|-----|------------|
| `type:decision` | an architectural or design choice, with the trade-off that settled it |
| `type:preference` | how the user wants things done |
| `type:root-cause` | a bug cause that took effort to uncover |
| `type:pattern` | a codebase convention documented nowhere else |
| `type:gotcha` | a non-obvious pitfall |
| `type:solution` | a non-trivial fix worth remembering |
| `type:workflow` | a multi-step process that works |

Tag each store with type: plus one of project: or scope:; add source: when the origin matters for trust, and priority: rarely.

When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:
- `lcm store "Acted on memory <id> — <one-line how>" --tag signal:memory_used --tag memory_id:<id>`

When you check a surfaced memory against current evidence, vote on it (reason is required both ways):
- `lcm store "<what confirmed it, e.g. a file, test, or command output>" --tag signal:memory_vote --tag vote:+1 --tag memory_id:<id>`
- `lcm store "<what contradicts it>" --tag signal:memory_vote --tag vote:-1 --tag memory_id:<id>`

"Not relevant here" is not a -1 — only a real contradiction is.

## Examples

- `lcm search "How is authentication implemented?"`
- `lcm grep "createDaemon|startMcpServer" --mode regex`
- `lcm describe sum_abc123def456`
- `lcm expand sum_abc123def456 --depth 2`
- `lcm store "Auth uses JWT with 24h expiry instead of server sessions: the API stays stateless across instances. See src/middleware/auth.ts" --tag type:decision --tag scope:security`

## When a command fails

- `lcm` not found: `npm install -g @lossless-claude/lcm`
- daemon down: `lcm daemon start --detach`
- search returns nothing: memory may be empty; proceed normally
- anything else: `lcm doctor`
