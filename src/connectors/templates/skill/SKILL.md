---
name: lcm-memory
description: Lossless context management — search and store persistent memory across sessions
---

# Lossless Context Management

> **Before responding to code tasks, check memory first.**
> Code task? → `lcm search` FIRST. Durable insight? → `lcm store` before done.

You have access to a persistent memory system that survives across conversations.

## Workflow

Code task received → `lcm search` FIRST → Work → durable insight? → `lcm store` → Done
Non-code task → Just respond normally

## Commands

### 1. Search Memory
Retrieve relevant context before starting work.
```bash
lcm search "How is authentication implemented?"
```

### 2. Grep Memory
Regex pattern search for precise matches.
```bash
lcm grep "createDaemon|startMcpServer" --mode regex
```

### 3. Describe Memory
Inspect a specific node returned by search or grep.
```bash
lcm describe sum_abc123def456
```

### 4. Expand Memory
Recover lower-level detail from a summary node.
```bash
lcm expand sum_abc123def456 --depth 2
```

### 5. Store Knowledge
Store durable insights (decision, preference, root-cause, pattern, gotcha, solution, workflow) explicitly with `lcm store`, tagged with `type:`. One concise insight and its why per store.
```bash
lcm store "Auth uses JWT with 24h expiry instead of server sessions: the API stays stateless across instances. See src/middleware/auth.ts" --tag type:decision --tag scope:security
```

### 6. Stats
Show token savings and compression ratios.
```bash
lcm stats
```

## Decision Table

| Task Type | Search? | Store? |
|-----------|---------|--------|
| Add/create/implement feature | MUST | If durable insight |
| Fix/debug/resolve bug | MUST | If durable insight |
| Refactor/optimize/move code | MUST | If durable insight |
| Write/add tests | MUST | If durable insight |
| "How does X work?" (codebase) | MUST | If durable insight |
| General concept question | NO | NO |
| Meta task (run tests, build) | NO | NO |
| Git task (commit, PR, push) | NO | NO |

## Error Handling

- If `lcm` is not found: run `npm install -g @lossless-claude/lcm`
- If daemon is down: run `lcm daemon start --detach`
- If search returns nothing: memory may be empty — proceed normally
- Check status: `lcm doctor`
