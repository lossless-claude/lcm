# lcm Dogfood — Known Issues

Track bugs at: `.xgh/plans/2026-03-22-dogfood-findings.md`

| Bug | Summary | Affects | Status |
|-----|---------|---------|--------|
| 1 | prompt-search only queries promoted store, not summaries or messages | Check 7.3, 7.4 | Open |
| 2 | `env: node: No such file or directory` in daemon.log — PATH not set in spawned processes | Check 10.1 | Open |
| 3 | No request logging in daemon — zero visibility into runtime requests | Check 10.1 | Open |
| 4 | Config file has stale restoration fields (semanticTopK vs promptSearchMaxResults) | N/A (defaults work) | Low |
| 5 | Skill checked settings.json instead of plugin.json for hooks | Check 7.1 | Fixed |
