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

1. Merge the changesets version PR (opened automatically by `version-pr.yml`),
   or bump the version by hand across `package.json`, `package-lock.json`,
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and move
   the CHANGELOG's top section to the release date.
2. The push to `main` publishes, because the workflow watches `package.json`.
   Run it manually with `gh workflow run publish.yml --ref main` when the
   version file did not change in that push.
3. The workflow skips a version already on npm or already tagged, so an
   ordinary merge is a no-op and a re-run after a failure is safe.

It publishes, then tags `vX.Y.Z`, then opens the GitHub release with the
CHANGELOG section. A failure before the publish step leaves no tag behind.

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
