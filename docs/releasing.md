# Releasing

Publishing runs from `main` through `.github/workflows/publish.yml`, and is
authenticated by **trusted publishing (OIDC)** — no npm token is stored
anywhere. The registry verifies the workflow's own identity, granted by
`permissions: id-token: write`.

## One-time npm setup

On npmjs.com, under the package's **Settings → Trusted publishing**, add a
GitHub Actions publisher:

| Field | Value |
|---|---|
| Organization or user | `lossless-claude` |
| Repository | `lcm` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |

The environment must match the `environment:` key on the publish job, or the
registry rejects the token.

**Tick "Allow `npm publish`".** Without it the publisher may only run
`npm stage publish`, which parks the release until someone approves it on
npmjs.com; the workflow calls `npm publish` directly and would fail.

Then, under **Publishing access**, select *Require two-factor authentication
and disallow bypass 2fa tokens*. Trusted publishers work under either option,
so this only closes the stored-token path, which nothing uses any more. Do it
after the first successful OIDC publish, so the tightening follows proof that
the new path works. Interactive publishing with a 2FA code still works, so
there is no way to lock yourself out.

## Cutting a release

1. Run `gh workflow run version-pr.yml --ref main`. It opens or refreshes the
   changesets version PR from the changesets on `main`. Its version step is
   `npm run version-packages`: bump the version, sync the manifests, then build
   `dist/` and `bundle/`, so the committed bundle carries the new version. The
   action commits everything, `bundle/` included. CI runs on that commit. Merge
   it. (By hand instead: bump `package.json` and `package-lock.json`, run
   `node scripts/sync-versions.mjs`, `npm run build`, `npm run build:bundle`,
   and move the CHANGELOG's top section to the release date.)
2. The push to `main` publishes, because the workflow watches `package.json`.
   Run it manually with `gh workflow run publish.yml --ref main` when the
   version file did not change in that push.
3. The workflow does each step only if it is still missing: tag, npm, GitHub
   release. An ordinary merge is a no-op, and a re-run after a partial failure
   finishes what is left. It never builds or commits `bundle/`.

The tag comes first, because the marketplace entry for the same version points
at it: `sync-versions.mjs` writes `ref: vX.Y.Z` next to the version, so a fresh
plugin install fetches the released commit rather than the current `main`.
Between the merge and the tag step there is a window of about a minute in which
that install fails; the workflow closes it on its own.

`bundle/` is the plugin artifact (`docs/design/self-contained-plugin.md`): a
marketplace install runs it with only `node` on PATH. It changes only in version
PRs, so between releases `main` carries the previous release's bundle; `npm run
build` never touches it, and `.gitattributes` diffs it as binary. `dist/` stays
the npm artifact.

## Release channels

| Host | Installs from | Pinned by |
|---|---|---|
| Claude Code plugin | this repository, marketplace `source.ref`; runs `bundle/` | the tag `vX.Y.Z` and `version` in `.claude-plugin/marketplace.json` |
| Codex, Copilot, CLI | npm `@lossless-claude/lcm` | the published version |

Codex also reads `.claude-plugin/marketplace.json` as a compatible marketplace; a
Codex entry there would use `source: npm` with the exact version, which
`sync-versions.mjs` writes when such an entry exists. There is no release branch:
the tag and the npm version are the release boundary for every host.

## Why not a token

npm granular access tokens that bypass 2FA lose the ability to publish
directly around January 2027, and already cannot perform account or package
management. Trusted publishing replaces them and expires nothing.

## Local publishing

Only as a fallback, and it needs an interactive 2FA code:

```bash
npm publish --access public --otp=<code>
```

Then create the tag and release by hand, which the workflow would otherwise do.
