## Summary

<!-- What changed? Be specific — Copilot uses this for review context. -->

## Motivation / Why

<!-- Why is this change needed? What problem does it solve? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no behavior change)
- [ ] Chore / infra / config
- [ ] Documentation

## Testing done

<!-- Describe how you tested. New routes should have tests in test/daemon/routes/. -->

## Related issues

<!-- Closes #N -->

## Copilot review focus areas

> This repo is a TypeScript SQLite daemon (lossless-claude / lcm).
> Please pay extra attention to:

- **DB connection pattern**: All DB access uses `getLcmConnection()`/`closeLcmConnection()`? No `new DatabaseSync()` directly?
- **PRAGMA enforcement**: New connections set `journal_mode=WAL` and `foreign_keys=ON`?
- **Type safety**: No `any` types added without explicit justification? All function signatures typed?
- **`collectStats()` hot path**: Is `collectStats()` (~13s) called in any request handler or hot path? It must not be.
- **Test coverage**: New routes have corresponding tests in `test/daemon/routes/`?
- **SQLite transactions**: Are multi-step writes wrapped in transactions to prevent partial writes?
- **Error handling**: Do route handlers return structured error responses, not raw exceptions?
- **Migration safety**: Are schema migrations additive-only (no DROP COLUMN, no type changes)?

## Checklist

- [ ] DB access only via `getLcmConnection()`/`closeLcmConnection()` — no direct `DatabaseSync`
- [ ] New connections set `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
- [ ] No `implicit any` — all types explicit
- [ ] `collectStats()` not called in request handlers or hot paths
- [ ] New routes have tests in `test/daemon/routes/`
- [ ] Multi-step writes use transactions
- [ ] Schema migrations are additive only
- [ ] Test suite passes: `npm test`
