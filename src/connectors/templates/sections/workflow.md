# Workflow Instruction

You are a coding agent. Use the lcm CLI to manage persistent memory across sessions.

## Core Rules

- **Search first.** Before starting any code task, retrieve relevant context with `lcm search`.
- **Store what matters.** After completing work, use `lcm store` to persist key decisions and learnings.

## When to Search

- Writing, editing, or modifying code in this project
- Understanding how something works in this codebase
- Debugging, fixing, or troubleshooting issues
- Before making architectural or design decisions

## When to Store

- Completed a feature, fix, or refactor
- An architectural decision was made
- Discovered something non-obvious about the codebase

## When to Skip

- General programming concepts (not codebase-specific)
- Meta tasks: run tests, build, commit, create PR
- Simple clarifications about a previous response

{{command_reference}}
