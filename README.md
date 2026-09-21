# Load and Run

Source for customizable personal and shared spaces for notes, links, tasks, ideas, videos, and GitHub projects, with AI adapters exercised using mocked providers.

A code-only project built with plain JavaScript, TypeScript Workers and SQLite-backed Durable Objects. Cloudflare Access and WorkOS adapters are retained for local testing and architecture review. There is no hosted service or deployment workflow in this project; configuration contains no operator account or authentication application. The former Cloudflare Worker and its four Durable Object namespaces were deleted on September 21, 2026; this repository contains source and synthetic fixtures, not that stored data.

## Try it locally

Requires Node.js 22.13+ and npm:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4173**. The offline demo uses the real catalog and community interface, plus fictional builders, groups, projects and posts. Create a group, save an idea or post an update. Changes stay in memory and disappear on restart. No Cloudflare account, WorkOS account, API key or AI billing is needed. External source links open only when you choose them.

The demo intentionally covers the community workflow. The broader authentication, shared-space and collaboration implementation is available for local testing as described in [local development](LOCAL-README.md); tests mock AI providers. Demo identities never enter the production authentication path.

## What is implemented

- **Spaces:** seven configurable widget types, independent Durable Object storage, invitation-based viewer/editor/owner roles, private AI chat and optional shared recommendations.
- **Ideas:** 41 detailed briefs with historical sources, practical build plans and separately scoped software-reuse terms.
- **Community:** posts, comments, reactions, groups, shared projects and saved ideas.
- **Identity boundaries:** the retained adapters validate Access and WorkOS identities; Durable Objects enforce ownership and membership in local integration tests.
- **AI boundaries:** owners select shared context and provider consent; per-builder job budgets and cancellation protect availability. AI is disabled in the public default configuration.

The test suite exercises Access rejection, CSRF, OAuth state, identity linking, tenant boundaries, revocation, storage restart and late AI replies. It uses local fixtures, not the operator's accounts.

## Validate

```sh
npm run check
npm test
npm run build
```

CI runs these checks without deployment credentials. See [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

## Architecture and operations

- [Local development and demo limitations](LOCAL-README.md)
- [Cloudflare source and local testing](CLOUDFLARE.md)
- [Data flow and retention](docs/DATA_FLOW_AND_RETENTION.md)
- [Community features and access model](COMMUNITY.md)
- [Spaces, sharing and optional AI](SPACES.md)
- [Cost controls](COSTS.md)
- [Catalog and editorial standards](CORPUS.md)
- [Catalog rights review](CATALOG-RIGHTS-REVIEW.md)

This project is code-only. Deployment and remote-provisioning commands have been removed. CI builds, tests and scans code; it does not deploy a service or publish packages. Local demo and Worker development commands bind to loopback.

## License and provenance

Original application code is licensed under [MIT](LICENSE). The [third-party notices](THIRD_PARTY_NOTICES.md) explain dependency, catalog, source-document and license-text boundaries. Links to historical software do not license its papers, branding or assets. Legacy design handoffs with unresolved redistribution terms are excluded from this source distribution.
