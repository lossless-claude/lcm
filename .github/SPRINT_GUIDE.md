# Sprint Guide

## Sprint Cadence

- **Sprint = 1 day** (aligned to Anthropic token budget daily reset)
- **Milestone = 1 week** (Tuesday to Monday, ISO week numbering: W2026-NN)
- **Ceremony:** End of each weekly milestone

## Milestone Naming

Format: `W2026-NN` where NN is the ISO week number.

## Sprint Workflow

### Daily
1. `/standup` — review yesterday, plan today
2. Work items from project board (highest priority first)
3. PRs follow quality gates: ar-coverage, quality-gates
4. End of day: `/introspection` for all agents

### Weekly Ceremony
1. Close current milestone
2. Move unfinished items to next milestone
3. Create retrospective issue (label: `post-mortem`)
4. Review velocity metrics
5. Create next week's milestones across all repos
6. Triage `introspection` issues

## Labels

### Priority (mutually exclusive)
- `p0-critical` — production broken, immediate
- `p1-high` — current sprint, blocks delivery
- `p2-medium` — next sprint
- `p3-low` — backlog

### Type (mutually exclusive)
- `bug` — something broken
- `enhancement` — new feature or improvement
- `chore` — maintenance, CI, config
- `research` — spike, investigation
- `skill-proposal` — new skill for the org

## Project Board

All work tracked on [Org Operations v2](https://github.com/users/ipedro/projects/5).

Views:
1. **Sprint Board** — current sprint kanban
2. **Triage** — unprocessed items
3. **Roadmap** — timeline view
4. **By Product** — per-repo focus
5. **Backlog** — prioritized backlog
6. **Done/Archive** — completed work
