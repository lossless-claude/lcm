# Tag schema

Tags are what `lcm search --tag` and the `tags` filter of `lcm_search` select on. This file
defines the shape a tag has and the prefixes the guidance recommends. The `lcm_store`
description and the learning instruction point here.

## Shape

A tag is `<prefix>:<value>`. A tag without a colon is stored and full-text searchable, but
no filter can select it by category: `decision`, `category:decision` and `type:decision`
are three different tags. Use the prefixed form for anything you intend to filter on later.

Values are lower-case, with `-` between words. Nothing enforces this at runtime; the schema
holds by convention, and a filter only finds what was stored with the exact same tag.

## Recommended prefixes

### `type:` — what kind of insight this is

| Value | When to use |
|-------|-------------|
| `type:decision` | An architectural or process decision, with the trade-off that settled it |
| `type:preference` | How the user or the team wants things done ("always X", "never Y") |
| `type:root-cause` | The identified cause of a bug, failure or incident |
| `type:pattern` | A recurring structure worth reusing: code shape, workflow, convention |
| `type:gotcha` | A non-obvious pitfall or surprising behaviour |
| `type:solution` | A specific fix or answer to a concrete problem |
| `type:workflow` | A step-by-step process that works |
| `type:feat`, `type:fix`, `type:chore` | The kind of change a piece of work was |

Passive promotion (`docs/passive-learning.md`) also produces `type:user-context` (from role
and identity statements) and `type:environment` (from install and setup commands). They
are valid filter values; a hand-written store rarely needs them.

### `scope:` — which domain the insight belongs to

| Value | When to use |
|-------|-------------|
| `scope:architecture` | System design, component structure, data flow |
| `scope:security` | Secret scanning, auth, access control |
| `scope:testing` | Test strategy, test infrastructure, test failures |
| `scope:ci` | CI pipelines, release automation |
| `scope:process` | Team workflow and governance |
| `scope:token-budget` | Context window management, quota, efficiency |
| `scope:model-selection` | Which model to route a task to |
| `scope:<name>` | Any other domain; keep one spelling per domain |

### `project:` — which repository or project

A free identifier that matches the repository or project name, for example `project:lcm`.
Use it when a memory would be misleading outside that project.

### `source:` — where the insight came from

| Value | When to use |
|-------|-------------|
| `source:session` | From a working session with the user |
| `source:review` | From a code or design review |
| `source:ci` | From automated CI output |
| `source:agent` | From a subagent's report |

### `priority:` — how urgent

`priority:P0` (system broken, data loss, security) through `priority:P3` (nice-to-have).
Most memories carry no priority.

## Combining tags

A store carries two to four tags: `type:` plus one of `project:` or `scope:`, and `source:`
when the origin matters for trust.

```
["type:solution", "scope:lcm", "project:lcm", "source:session"]
```

## Reserved tags

These tags carry protocol meaning and are not categories. A record carrying any `signal:`
tag is never returned by `lcm_search`, `lcm_grep`, or the prompt hook — it exists only to be
counted, not to be recalled as a memory in its own right.

- `signal:memory_used` together with `memory_id:<id>` marks a store as a usage report for
  the memory `<id>`. The stale memory review (`docs/configuration.md`, section "Stale memory review") counts
  these reports as uses of that memory. The learning instruction tells the model to emit them when it acts
  on a surfaced memory.
- `signal:memory_vote` together with `memory_id:<id>` and exactly one of `vote:+1` /
  `vote:-1` records a vote on the memory `<id>`. `+1` means "checked against current
  evidence and still correct"; `-1` means a specific piece of evidence contradicts it. A
  reason is required for both — the store's `text` — naming what confirmed (`+1`) or
  contradicts (`-1`) the memory; "not relevant here" is not a `-1`. A vote missing
  `memory_id:`, carrying more than one `memory_id:` or `vote:` tag, an unrecognized vote
  value, or an empty reason is rejected with a message naming the rule. The target memory
  may live in a sibling checkout of the same repository; the store resolves it the way
  `lcm_describe` resolves a `projectId`. `lcm stats` (and `lcm_stats`) surface vote counts
  under "Promotion candidates" and "Contested"; see `docs/configuration.md`.

Passive promotion tags an event whose category has no `type:` mapping as
`category:<category>`. Those are internal; filter on `type:` instead.
