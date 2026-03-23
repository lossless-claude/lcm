# Rebranding Design: lossless-claude → @lossless-claude/lcm

**Date:** 2026-03-21
**Status:** Approved

## Summary

Move the project from personal namespace (`@ipedro/lossless-claude`, `ipedro/lossless-claude`) to the `lossless-claude` GitHub organization and npm scope (`@lossless-claude/lcm`, `lossless-claude/lcm`). The CLI binary (`lcm`) and domain (`lossless-claude.com`) are unchanged. Version `1.0.0` is reserved for the official launch; `0.7.0` is used to validate the pipeline end-to-end.

**Note on redirects:** This is a fresh repo, not a transfer. GitHub will NOT redirect `ipedro/lossless-claude` clone URLs automatically. Users with the old URL will get 404s once the old repo is taken down. This is accepted — the old repo is being retired intentionally.

## Phase 1: Infrastructure (manual, this session)

Steps executed in the current session before any code changes:

1. Create `lossless-claude/lcm` on GitHub via `gh repo create lossless-claude/lcm --public`
2. Update git remote — point `origin` at `git@github.com:lossless-claude/lcm.git`
3. Push all branches — `main`, `develop`, current fix branch, and `github-pages`
4. Configure GitHub Pages on the new repo (source: `github-pages` branch); re-apply the `lossless-claude.com` CNAME on the new repo
5. Set up secret `NPM_TOKEN` on the new repo; `MARKETPLACE_TOKEN` is removed (no longer needed)
6. Run `npm deprecate @ipedro/lossless-claude "Package moved to @lossless-claude/lcm"`

The old `ipedro/lossless-claude` repo will be taken down manually by the owner at a later date. Open issues/PRs should be reviewed and migrated or closed before teardown.

## Phase 2: Codex file changes (one PR)

**All user-facing content (README, docs, claude-plugin) must be updated with the new name and install instructions before the version is bumped and published.** The PR should be reviewed to confirm install instructions are correct end-to-end before merging.

### File changes

| File | Change |
|---|---|
| `package.json` | `name` → `@lossless-claude/lcm`; `version` → `0.7.0`; `repository.url` → `git+https://github.com/lossless-claude/lcm.git`; `homepage`, `bugs.url` → `lossless-claude/lcm` |
| `README.md` | npm badge URL, GitHub URLs, npm install command (`npm i @lossless-claude/lcm`), claude-plugin install instructions — `lossless-claude.com` domain unchanged |
| `docs/*.md` | All hardcoded `ipedro` or `@ipedro/lossless-claude` refs replaced; check for old install instructions |
| `github-pages` branch | Audit for hardcoded `ipedro/lossless-claude` URLs and old install commands; update before site goes live |
| `.claude-plugin/*.json` | Plugin name, repo URL, install instructions if present |
| `.github/workflows/publish.yml` | Remove external `ipedro/xgh-marketplace` step; add step to update `.claude-plugin/marketplace.json` version field, commit to `main`, then tag + release. Workflow must have `contents: write` permission (already set) and use `github.token` for the commit push. |
| `.github/workflows/version-pr.yml` | Any `ipedro` refs replaced |

### Marketplace: self-referential

The plugin manifest (`.claude-plugin/marketplace.json`) lives in this repo. The publish workflow updates the `version` field in that file, commits it to `main`, then tags. No external API call, no `MARKETPLACE_TOKEN` required.

## Phase 3: Validation

After the Codex PR is merged:

1. **Audit user-facing content** — manually verify README install instructions, claude-plugin instructions, and website copy all reflect `@lossless-claude/lcm` before triggering publish
2. `npm pack --dry-run` — verify package contents, name, and `repository` field
3. Trigger `publish.yml` manually targeting `0.7.0`
4. Confirm `@lossless-claude/lcm@0.7.0` appears on npm registry
5. Confirm `lossless-claude.com` resolves correctly (CNAME active on new repo)
6. If validation fails, fix and republish as `0.7.1`; `1.0.0` is not cut until a clean `0.7.x` publish succeeds

## What does NOT change

- CLI binary name: `lcm`
- Domain: `lossless-claude.com`
- Author credit: Pedro Almeida
- License: MIT
- Version `1.0.0` is reserved for the official public launch
