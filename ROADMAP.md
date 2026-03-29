# Version Roadmap — @lossless-claude/lcm

## Unreleased

_(no features queued — v0.8.0 shipped 2026-03-28)_

---

## v0.9.0 — Candidates

- [ ] Copilot PR review negotiation workflow (round-count metric)
- [ ] Permissions granularity improvements for agent teammates

---

## v0.8.0 — 2026-03-28

### Added
- Connection pooling for sidecar EventsDb (#131)
- Portable knowledge export/import — `lcm export`, `lcm import-knowledge` (#132)
- Pool stats observable — `lcm stats --pool` + `GET /stats/pool` daemon endpoint
- AR coverage gate CI workflow
- Enriched GitHub Release notes — CHANGELOG extraction + npm badge (#173)
- Copilot auto-review on all PRs

### Fixed
- `post-tool` command not registered in CLI dispatcher (#162)
- Security: upgraded hono, rollup, picomatch (3 high CVEs)
- Security: CodeQL stack-trace exposure + sanitizeError backslash handling (#175)
- Atomic meta.json write in `importKnowledge` — prevents crash mid-write corruption (#171)
- `redaction_stats` migration for v0.7.0 → v0.8.0 upgrades (#171)

---

## v0.7.0 — 2026-03-26

_(see CHANGELOG.md)_

## v0.6.0 — 2026-03-25

_(see CHANGELOG.md)_

## v0.5.0 — 2026-03-23

_(see CHANGELOG.md)_

## v0.4.x — 2026-03-23

_(see CHANGELOG.md)_

## v0.1.0

Initial release.
