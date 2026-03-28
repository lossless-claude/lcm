# LCM Canonical Tag Schema

> **Status:** Canonical — all agents and tools must follow this schema.
> **Source of truth:** This file. The `lcm_store` MCP tool description references it.

## Why a schema?

Without a canonical schema, the same decision gets stored as `decision:X`, `category:decision`, or just `decision` — making `lcm_search` with tag filters unreliable. The canonical schema enforces consistent `<prefix>:<value>` pairs so any agent can construct a precise search filter.

## Schema

All tags follow the `<prefix>:<value>` format. Free-text tags (no colon) are allowed but are not searchable by category — prefer canonical tags for anything you intend to filter on later.

### `type:` — what kind of insight is this?

| Value | When to use |
|-------|-------------|
| `type:decision` | An architectural or process decision with trade-offs evaluated |
| `type:preference` | A user or team preference ("always do X", "never do Y") |
| `type:root-cause` | The identified cause of a bug, failure, or incident |
| `type:pattern` | A recurring pattern worth reusing (code structure, workflow, etc.) |
| `type:gotcha` | A non-obvious pitfall, footgun, or surprising behavior |
| `type:solution` | A specific fix or answer to a concrete problem |
| `type:workflow` | A step-by-step process or runbook |
| `type:feat` | A feature addition or enhancement |
| `type:fix` | A bug fix |
| `type:chore` | Maintenance, refactoring, or tooling work |

### `scope:` — what domain does this belong to?

| Value | When to use |
|-------|-------------|
| `scope:token-budget` | Token window management, quota, efficiency |
| `scope:model-selection` | Haiku vs Sonnet vs Opus routing decisions |
| `scope:architecture` | System design, component structure, data flow |
| `scope:process` | Team workflow, governance, sprint cadence |
| `scope:xgh` | Anything in or about the xgh repo |
| `scope:autoimprove` | Anything in or about the autoimprove repo |
| `scope:lcm` | Anything in or about lossless-claude itself |
| `scope:security` | Secret scanning, auth, access control |
| `scope:testing` | Test strategy, test infrastructure, test failures |
| `scope:ci` | CI/CD pipelines, GitHub Actions, release automation |

### `priority:` — how urgent or important?

| Value | When to use |
|-------|-------------|
| `priority:P0` | Critical — system broken, data loss, security issue |
| `priority:P1` | High — blocks a sprint or a release |
| `priority:P2` | Normal — should be addressed in current or next sprint |
| `priority:P3` | Low — nice-to-have, no deadline |

### `owner:` — who is responsible for acting on this?

| Value | When to use |
|-------|-------------|
| `owner:CTO` | Technical architecture, code quality, test coverage |
| `owner:COO` | Process, coordination, sprint management |
| `owner:team-lead-xgh` | xgh repo work |
| `owner:team-lead-autoimprove` | autoimprove repo work |
| `owner:team-lead-lcm` | lcm repo work |
| `owner:co-ceo` | Governance, strategic decisions, both Co-CEOs needed |

### `project:` — which project/repo?

Freeform identifier matching the repo or project name. Examples:
- `project:lcm`
- `project:xgh`
- `project:autoimprove`
- `project:claudinho`

### `sprint:` — which sprint?

Format: `sprint:spN` (e.g. `sprint:sp3`). Use the sprint declared in the current triage file header. Fallback: `sprint:YYYY-MM-DD`.

### `source:` — where did this insight come from?

| Value | When to use |
|-------|-------------|
| `source:adversarial-review` | From an Enthusiast/Adversary/Judge review cycle |
| `source:session` | From a Co-CEO working session |
| `source:ci` | From automated CI output |
| `source:agent` | From a teammate or subagent |
| `source:retrospective` | From a sprint retrospective |

## Combining tags

A single `lcm_store` entry should use 2–4 canonical tags, covering at minimum `type:` and one of `project:` or `scope:`. Sprint and source tags are recommended for traceability.

**Example — good:**
```
["type:solution", "scope:lcm", "project:lcm", "sprint:sp3", "source:session"]
```

**Example — bad (avoid):**
```
["solution", "lcm", "sp3"]
```
The bad form still works for full-text search but cannot be filtered by tag category.

## Migration note

Existing entries tagged with legacy formats (e.g. `category:decision`, `decision`, `category:gotcha`) are not retroactively migrated — the schema applies to new stores only. The `promote-events` AUTO_TAGS mapping uses `category:*` as an internal convention; those are separate from the canonical user-facing schema defined here.

## Validation

There is no runtime enforcement today — the schema is normative by convention. A future `lcm doctor` check may warn on tag-less entries or non-canonical formats.
