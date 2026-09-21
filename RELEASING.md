# Releasing

This repo uses Changesets to make npm releases reviewable.

## Normal development

For any pull request that changes user-facing behavior, a changeset should be
added before the work is considered ready to release:

```bash
npm run changeset
```

Choose the smallest appropriate bump:

- `patch`: fixes, docs-visible behavior changes, small compatibility work
- `minor`: new features or notable new behavior
- `major`: breaking changes

The generated markdown file in `.changeset/` should explain the release impact in a sentence or two.

PRs that only touch internal tooling or CI can skip a changeset when they do not need an npm release note.

## Who adds the changeset

Maintainers own release metadata.

- For internal PRs, the author can add the changeset directly.
- For external PRs, do not expect the contributor to know or run the Changesets
  workflow. The reviewer or merge maintainer should add the changeset before
  merge, or immediately afterward in a small follow-up PR.
- If a releasable PR lands without a changeset, create a catch-up changeset PR
  before running the release flow.

The practical rule is simple: if the change should appear in npm release notes,
make sure a maintainer gets a `.changeset/*.md` file onto `main`.

## Release flow

1. Merge releasable PRs to `main`
2. Let the `Version Packages` workflow open or update the release PR
3. Review the generated version bump and `CHANGELOG.md`
4. Merge the release PR to `main` — that push changes `package.json`, which runs `publish.yml`
5. Trigger the `Publish Package` workflow by hand only when the version file did not change (`gh workflow run publish.yml --ref main`)
6. Approve the workflow if a protected GitHub Environment is configured
7. Let the workflow, each step running only if its result is still missing:
   - install dependencies
   - run tests
   - create and push tag `vX.Y.Z`
   - publish to npm
   - create the GitHub release

## External setup required

The repo-side files are not enough by themselves. A maintainer still needs to configure npm trusted publishing for this GitHub repository/workflow pair.

Recommended external setup:

1. Configure npm trusted publishing for this repo and the `publish.yml` workflow
2. Optionally create a GitHub Environment named `npm-publish` and add required reviewers
3. Confirm the repository label taxonomy used by `.github/release.yml`

When configuring npm trusted publishing, register the GitHub workflow using the exact workflow filename in this repo: `.github/workflows/publish.yml`.

The publish workflow runs on its own when a push to `main` changes `package.json` — the merge of
the version PR. It can also be started by hand (`gh workflow run publish.yml --ref main`) for a
release whose version file did not change. Release issuance stays deliberate: every step is
skipped when its result already exists.
