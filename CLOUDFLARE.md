# Cloudflare source and local testing

This repository is code-only. It provides no deployment command, hosting workflow, or maintained hosted service. Cloudflare Workers, Durable Objects and WorkOS integration code remain available for architectural inspection and local tests.

## Local configuration

`wrangler.jsonc` contains no account ID, hostname route, owner email, Access audience or WorkOS application. Workers.dev and previews are disabled. Workers AI is unbound and disabled in every configured environment.

Use `npm run dev` for the offline community demo. `npm run dev:worker` explicitly selects local storage and loopback networking. Optional authentication integration requires the contributor's own WorkOS development configuration; synthetic tests require no provider account. There is no fallback to a maintainer account.

The default configuration retains fail-closed authentication checks; an absent Access configuration is never permission to serve a remote request. Keep all real credentials and operator settings outside Git. Do not restore the removed remote deployment or provisioning helpers.

## Architecture and local data

The source retains `Workspace` / `WORKSPACES`, `Space` / `SPACES`, `Widget` / `WIDGETS`, `SpaceDirectory` / `SPACE_DIRECTORIES`, and their migration definitions. Tests exercise those identities using temporary local data. The former Worker and these four cloud namespaces, including their stored data, were deleted on September 21, 2026. This source snapshot includes no cloud database export or provider identity records. The retained class names and migrations describe the implementation and support local tests; they do not refer to a maintained deployment.

WorkOS PKCE, Access JWT validation, opaque sessions, ownership and membership checks remain implemented for inspection/testing. The offline demo is a separate process with fictional state; it does not impersonate production authentication. Provider-side logs, independent account records and previously made copies are separate from this local source distribution; deleting the Worker was not a claim of erasure from every external system.

## Verification

Run `npm run check`, `npm test`, `npm run build` and the repository hygiene checks. The tests cover authentication/authorization boundaries, tenant isolation, revocation, provider failures and retention behavior with synthetic fixtures. Type generation uses the sanitized local configuration.

[Wrangler local development](https://developers.cloudflare.com/workers/development-testing/) and [data flow/retention](docs/DATA_FLOW_AND_RETENTION.md) describe the relevant runtime concepts. A future hosting decision requires a separate explicit instruction and review; it is not part of this project's current operation.
