# Security policy

This project is experimental. The current development branch receives fixes on a best-effort basis; no support period, response deadline, or production-security certification is promised.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** action when GitHub private vulnerability reporting is enabled. Include the affected revision, component, prerequisites, impact, and a minimal reproduction using synthetic data. Redact credentials, cookies, personal details, prompts, and private deployment identifiers. Do not include real user records or a complete production database.

If that private reporting action is unavailable, ask the maintainer for a private reporting channel in a public issue containing only that request, without vulnerability details. The maintainer must enable and test private vulnerability reporting before the repository is made public. This file does not assert that the GitHub setting is already enabled.

Test only a local or separately authorized environment. This code-only repository is not authorization to probe any historical service, bypass access controls, read another person's records or incur provider charges. No bug bounty is offered by this policy.

## Security boundaries to preserve

- There is no hosted service or deployment workflow. Retain the Access/WorkOS authentication and membership checks for local tests and architectural inspection.
- Public examples contain no operator identity or credential. Remote provisioning/deployment helpers are removed; keep any historical private settings and user storage outside Git.
- The retained AI adapters can process included widget content, private chat messages, and bounded conversation history when separately configured; the code-only default has no AI binding and uses mocked providers in tests. Recommendation discovery can send derived search terms to external providers. Do not treat AI prompts or query filtering as a guarantee that personal data cannot leave the service.
- Ordinary record removal and chat reset are not complete erasure of every stored copy. See [data flows and retention](docs/DATA_FLOW_AND_RETENTION.md) before making privacy or deletion claims.

## Maintainer response and release checks

Reproduce reports with synthetic data, assess affected revisions and deployments, and prepare a focused fix and regression coverage. Coordinate disclosure with the reporter without promising a timeline that cannot be met. If an actual credential is exposed, revoke or rotate it at its provider; deleting a file or rewriting Git history does not invalidate it.

Before source publication, review the complete Git history and all publication surfaces, including branches, tags, releases, CI artifacts/logs, screenshots, and generated files. Confirm unresolved design assets and private operational material remain excluded. Enable private reporting and available dependency/secret alerts, review the lockfile and distribution notices, and verify the local demonstration does not depend on private services. These are release tasks, not claims that those checks have already passed.

Any future change to the code-only policy must be explicitly authorized and reviewed against [AGENTS.md](AGENTS.md), [CLOUDFLARE.md](CLOUDFLARE.md), and [COSTS.md](COSTS.md). Keep local authentication and authorization tests intact; do not recreate a hosted service or import real identities as an incidental security fix.
