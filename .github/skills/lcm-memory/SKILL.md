---
name: lcm-memory
description: Lossless context management — search and store persistent memory across sessions
---

# Lossless Context Management

> **Before responding to code tasks, check memory first.**
> Code task? → `lcm search` FIRST. Completed work? → `lcm store` BEFORE done.

You have access to a persistent memory system that survives across conversations.

## Workflow

Code task received → `lcm search` FIRST → Work → `lcm store` → Done
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
Persist important knowledge after completing work.
```bash
lcm store "Auth middleware uses JWT with 24h expiry. See src/middleware/auth.ts"
```

### 6. Stats
Show token savings and compression ratios.
```bash
lcm stats
```

## Decision Table

| Task Type | Search? | Store? |
|-----------|---------|--------|
| Add/create/implement feature | MUST | MUST |
| Fix/debug/resolve bug | MUST | MUST |
| Refactor/optimize/move code | MUST | MUST |
| Write/add tests | MUST | MUST |
| "How does X work?" (codebase) | MUST | Only if insights |
| General concept question | NO | NO |
| Meta task (run tests, build) | NO | NO |
| Git task (commit, PR, push) | NO | NO |

## Error Handling

- If `lcm` is not found: run `npm install -g @lossless-claude/lcm`
- If daemon is down: run `lcm daemon start --detach`
- If search returns nothing: memory may be empty — proceed normally
- Check status: `lcm doctor`

