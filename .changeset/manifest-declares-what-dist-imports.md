---
"@lossless-claude/lcm": patch
---

fix: check-manifest verifies dist/ imports match declared dependencies and versions stay in step

The published MCP server could import a package the manifest never declared, which failed silently past the bootstrap's `npm install` and only surfaced as `CONNECTION_CLOSED` in a user's session. `npm run check-manifest` now runs in CI and before publish: it fails the build if `dist/` imports anything outside `dependencies` ∪ `peerDependencies` ∪ `optionalDependencies`, or if `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` disagree on version. `version-packages` now also runs `scripts/sync-versions.mjs` to keep the two plugin manifests in step with `package.json` automatically. `mcp.mjs`'s bootstrap no longer swallows a failed `npm install` or `npm run build` silently — the error now reaches stderr, next to the `CONNECTION_CLOSED` symptom in the debug log.
