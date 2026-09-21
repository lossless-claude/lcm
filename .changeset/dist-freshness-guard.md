---
"@lossless-claude/lcm": patch
---

chore: a build records the sources it was made from, and the suite refuses a stale one

`npm run build` now also writes `dist/BUILD_SOURCES`, a fingerprint of the files the build
reads (`src/`, `bin/`, `installer/`, `tsconfig.json`). The test suite recomputes it before
every test file and fails with the rebuild command when `dist/` no longer matches the working
tree.

Suites that spawn the built CLI — golden snapshots, help routing, daemon hold behaviour, the
e2e flows — compared a `dist/` built from older sources against committed expectations, so an
edit without a rebuild passed locally and failed in CI. Test infrastructure only: nothing
about the emitted CLI changes, apart from the new fingerprint file travelling with it.