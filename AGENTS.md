# Code-only operating policy

The user requires this project to remain code-only, with no hosted deployment.

- Do not deploy, publish a service, add deployment workflows, enable remote URLs, or provision hosting without a new explicit user instruction.
- Keep the local demo bound to loopback, synthetic and in memory. CI may build, test and scan source; it must not deploy or publish packages.
- Cloudflare/WorkOS adapters are retained as source for local tests and architectural inspection. Keep authentication and authorization boundaries intact; do not introduce a hosted bypass.
- Keep Workers AI unbound and disabled in the tracked configuration. Use mocked providers for tests and avoid paid calls during verification.
- The former Cloudflare Worker and its four Durable Object namespaces were deleted with the owner’s authorization. Do not recreate hosting, restore historical user data or copy private records into source. Keep any future local test state synthetic and disposable.
- Never commit operator configuration, credentials, private sessions, user records or operational logs. Run the repository hygiene and secret checks over retained history.
- Keep third-party/catalog rights separate from the original application's MIT license.

See LOCAL-README.md for local use, CLOUDFLARE.md for the retained source architecture, and docs/DATA_FLOW_AND_RETENTION.md for data-handling boundaries.
