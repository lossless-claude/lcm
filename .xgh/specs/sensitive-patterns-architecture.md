# Sensitive Patterns Architecture

## Current architecture

- `DaemonConfig` is a single global object loaded from `~/.lossless-claude/config.json` by `loadDaemonConfig(configPath, overrides?, env?)`.
- Current top-level sections are `version`, `daemon`, `compaction`, `restoration`, and `llm`.
- Loading is read-only plus deep-merge with defaults and runtime overrides; there is no generic config save layer and no existing per-project config merge.
- Per-project state already exists separately under `~/.lossless-claude/projects/<sha256(cwd)>/`, with `db.sqlite` and `meta.json`, derived from `cwd` via `projectId`, `projectDir`, and `ensureProjectDir`.

## Option scores

| Option | Fit | Ergonomics | Secret safety | Composability | Complexity |
|---|---:|---:|---:|---:|---:|
| A. Global `config.json` array | 5 | 3 | 5 | 1 | 5 |
| B. `.lcmignore` in project root | 2 | 3 | 1 | 2 | 3 |
| C. Global `config.json` + per-project hashed file | 4 | 3 | 5 | 5 | 3 |

## Notes

- **A** fits the current config loader best and is the smallest change, but it makes every pattern active everywhere. That is a poor match for repo-specific secrets and increases accidental over-redaction across unrelated projects.
- **B** is discoverable, but it cuts against the current architecture: lossless-claude stores project state in `~/.lossless-claude/projects/...`, not in the repo root. It also has the highest git-leak risk, and `.lcmignore` suggests gitignore/glob semantics rather than regex-based redaction.
- **C** matches the repo’s existing split most cleanly: global behavior in `config.json`, project-specific state in hashed project directories keyed by `cwd`. It introduces a new merge path, but that is structurally consistent with how the daemon already resolves per-project storage.

## Recommendation

Recommend **Option C**, with a small refinement: keep optional global defaults as `sensitivePatterns: string[]` in `config.json`, and store project additions in `~/.lossless-claude/projects/{hash}/sensitive-patterns.txt`.

Merge order should be global first, then project-specific additions. The only real weakness is discoverability of hashed paths, so the elegant follow-up is a CLI or daemon helper for managing the per-project file rather than asking users to browse hashed directories manually.
