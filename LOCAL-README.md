# Local development

## Offline demo: no accounts or inference

Use Node.js 22.13+:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. This loopback-only Node server serves the production frontend and catalog, and reuses community validation with a fictional in-memory community. You can browse ideas, save them, create groups/projects, post and comment. Restart to discard changes. Do not enter personal or confidential data.

No WorkOS authentication, Cloudflare Access, Durable Object persistence, shared Spaces, WebSocket collaboration or AI is simulated as production functionality. The full implementation is retained for local Worker tests, not as a hosted service. Repository metadata lookup is disabled in the demo so posting a URL cannot make a server-side outbound call. A persistent banner identifies the demo and its limits. The demo removes remote font loading and applies a same-origin network policy.

## Full Worker development: your own configuration

`npm run dev:worker` runs local storage and binds `127.0.0.1`. Public `wrangler.jsonc` uses blank WorkOS settings and no AI binding in its local environment, so authentication intentionally fails until you configure your own WorkOS Staging project. It never falls back to the owner's accounts or password login.

Create ignored `.dev.vars.local` using `.dev.vars.local.example`, set your own Staging client/issuer/origins, and register `http://127.0.0.1:4173/auth/callback` in that WorkOS application. Register `/spaces` as a logout return. Leave custom hosted signup/password-reset overrides unset. The PKCE flow does not require an API key when supported by your provider settings; if one is required, keep it in the ignored file.

Then:

```sh
npm run dev:worker
```

Workers use local Durable Object storage under `.wrangler/`. No production records are copied. Authentication is an external WorkOS request once configured; it is not an offline workflow. Missing configuration fails closed. Local Access bypass requires both `ENVIRONMENT=local` and a loopback request hostname; production never bypasses the gate.

Workers AI remains unbound and disabled. Tests inject mocked providers. Do not add remote bindings, enable paid inference or deploy the Worker as part of this code-only workflow. Never place keys in browser code or tracked configuration.

## Quality checks

```sh
npm run check
npm test
npm run build
npm run types
```

Tests create local temporary SQLite/Miniflare state with synthetic identities and mocked provider responses. The publication preparation test covers demo Host/Origin boundaries, outbound-request rejection and safe public configuration. Type generation uses the sanitized tracked config. Do not regenerate public types from an operator's private configuration because literal identifiers may be included.

`node scripts/seed.mjs` regenerates the catalog from reviewed editorial JSON and preserves publication filtering. Legacy design HTML/runtime is not required. This command changes `src/data.json`; inspect the diff before accepting catalog changes.
