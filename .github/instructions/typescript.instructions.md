---
applyTo: "**/*.ts"
---

# TypeScript Conventions

- `node:` prefix for all Node.js built-in imports
- `import type { ... }` when only importing types
- `DatabaseSync` from `node:sqlite` (not third-party SQLite wrappers)
- Vitest for testing (`describe`, `it`, `expect`, `vi`)
