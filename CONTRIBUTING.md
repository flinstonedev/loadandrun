# Contributing

Load and Run is an experimental code-only project. Contributions must remain local code, tests and documentation; there is no deployment or package-publication workflow.

## Work locally

Use Node.js 22.13 or later and the committed lockfile:

```sh
npm ci
npm run dev
```

The default development command opens the isolated local demo with synthetic data. It does not provide the hosted Spaces, Workers AI, or WorkOS sign-in features. See the [README](README.md) and [local setup](LOCAL-README.md) for its supported flows and the separate `npm run dev:worker` integration workflow. Use your own development account and synthetic records when testing provider integrations; never copy historical user databases, cookies, tokens or real content into a fixture.

Before submitting code, run:

```sh
npm run check
npm test
npm run build
```

Some runtime tests need loopback networking. Describe any check you could not run and why; passing a mocked test is not proof that a provider integration works. Do not deploy or make a paid provider call as part of an ordinary contribution check. A documentation-only change normally needs a review of its claims and links rather than a new test suite.

## Propose a focused change

Describe the problem, the resulting behavior, and how you checked it. Include synthetic before-and-after examples or screenshots for visible changes. Add meaningful regression coverage for changes to authentication, authorization, data removal, catalog eligibility, or AI context selection. Document migrations and rollback implications when persistent state changes.

Preserve these boundaries:

- Preserve the authentication and authorization checks in the retained source. Local demos must not become a remote authentication bypass.
- Do not add deployment commands, cloud provisioning, remote AI bindings or hosting workflows. Never commit operator settings, provider resource IDs or live credentials.
- Keep Durable Object class and binding identities consistent with the local fixtures and migration definitions. Do not automatically link accounts by matching names or email addresses. See [operating constraints](AGENTS.md) and [operations](CLOUDFLARE.md).
- Membership and ownership are enforced in the application. Keep shared recommendation consent distinct from a user's private chat request, and respect per-widget AI inclusion.
- Do not log credentials, prompts, private widget contents, or raw provider errors. Keep the [data flow and retention document](docs/DATA_FLOW_AND_RETENTION.md) accurate when data handling changes.

## Rights and catalog changes

Submit only material you have permission to contribute. Contributions to original application software and its original software documentation are offered under the [MIT license](LICENSE). Do not assume that grant covers catalog content, copied source material, license text, fonts, or other third-party assets; follow [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Catalog additions need the source evidence, exact implementation/license revision, scoped rights, visible conditions, and complete brief fields described in [CORPUS.md](CORPUS.md). Keep held entries held until the evidence supports a new decision. Do not weaken the publication filter to make an entry pass. Preserve the original license text and applicable notices. Legacy design assets with unresolved provenance must remain excluded.

For security findings, follow [SECURITY.md](SECURITY.md) rather than publishing an exploit, token, or private record in an issue or pull request.
