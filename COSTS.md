# Local execution and costs

This project is code-only: it has no deployment commands or hosting workflow. The default `npm run dev` demo uses local in-memory fixtures, makes no server-side outbound requests and needs no provider credentials. Dependency installation may contact the package registry.

Local Worker tests use temporary Durable Object storage and mocked model responses. Workers AI is unbound and disabled. Optional WorkOS authentication testing contacts a contributor's own development project only after explicit local configuration; the offline demo needs no account.

Do not provision cloud resources, enable paid inference, or publish a service while validating this repository. The retained AI adapter includes request-count quotas for architectural testing; they are not monetary billing limits or authorization to run a hosted service.

The former Cloudflare Worker and its four Durable Object namespaces and stored data were deleted on September 21, 2026. This repository maintains no cloud service or stored cloud dataset. Independent provider accounts, logs and previously made copies are outside this source distribution. No private billing records or operator identifiers belong in the repository.
