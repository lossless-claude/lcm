# Security Runbook

## Secret Exposure Response

1. **Revoke** the exposed secret immediately
2. **Rotate** any derived credentials
3. **Search** git history for other instances: `git log -p --all -S 'secret_pattern'`
4. **Notify** Co-CEOs via Telegram
5. **Create** a post-mortem issue with label `p0-critical`

## Secret Scanning

- GitHub secret scanning is enabled on this repo
- Push protection blocks pushes containing known secret patterns
- Custom patterns configured via gitleaks (lcm repo)

## Branch Protection

- `main` branch is protected — PRs required
- Status checks must pass: ar-coverage, quality-gates
- Force push is disabled
- Branch deletion is disabled

## Dependency Management

- Dependabot security updates are enabled
- Review and merge dependency PRs promptly
- CodeQL analysis runs on all PRs

## Incident Escalation

| Severity | Response Time | Channel |
|----------|--------------|---------|
| P0 — credentials exposed | Immediate | Telegram + issue |
| P1 — vulnerability found | Same day | GitHub issue |
| P2 — dependency update | Next sprint | PR review |

## Contacts

- Pedro Almeida (@ipedro) — org owner, final authority
