# Spaces and AI adapter architecture

This guide describes the retained implementation and its local tests. The repository is code-only: it provides no hosted Spaces service, Cloudflare Workers AI is unbound and disabled, and the former Worker and its four Durable Object namespaces were deleted with their stored data on September 21, 2026.

The default offline demo shows the catalog and community workflow. It does not expose Spaces, real sign-in, live collaboration or inference. See [local development](LOCAL-README.md) for the separate local Worker setup and its synthetic integration tests.

## Spaces and permissions

The implementation supports configurable dashboards containing notes, links, tasks, published ideas, public GitHub repository metadata, video metadata and recommendations. Spaces are private by default. Invitations name an existing builder and require in-app acceptance; no invitation email is sent.

Owners control sharing, deletion and shared AI settings. Editors can change widgets and layout. Viewers can read shared content; the source also implements per-builder private chat. Space membership is authoritative: knowing a widget ID or having a directory entry does not grant access.

WorkOS PKCE and Cloudflare Access JWT adapters remain separate from ownership checks. Local integration tests exercise their boundaries using fixtures. A matching email, display name, WorkOS organization or Access identity does not silently link accounts or grant membership. Legacy password claims are explicit and retire the prior password credentials after linking.

## AI context and job lifecycle

Tests use mocked models and provider metadata. No live inference check or paid provider call is part of the public repository workflow.

The retained recommendation path requires the owner's consent and selects widgets marked for AI inclusion. Automatic recommendations start disabled. Private chat is isolated per builder and space; the shared recommendation consent setting is not a global block on member-initiated chat. The source preserves older provider conversations as a separate archive rather than automatically sending them to a new model.

The adapter bounds selected content, chat history and completion size. Its queue admits one running job per builder, coalesces pending edits, debounces automatic work for 60 seconds and spaces automatic runs at least ten minutes apart. Request-count budgets are twelve automatic jobs per owner and forty manual jobs per builder per UTC day. These are tested implementation limits, not a hosted-service offering or a monetary spending cap.

Cancelling a job prevents a late result from being applied. In a separately configured integration it cannot retract a request already accepted by a provider. Context and membership changes are checked again before results are saved. Recommendation candidates are verified through metadata adapters rather than accepted as arbitrary model-generated URLs.

`SPACES_AI_ENABLED=false` prevents new inference admission; the tracked configuration also omits the AI binding. Do not add remote bindings, deploy code or enable paid inference during normal contribution checks. See [cost policy](COSTS.md).

## Storage model

| Binding / class | Scope | Stored implementation state |
| --- | --- | --- |
| `WORKSPACES` / `Workspace` | Community | Builder records, sessions and community collections |
| `SPACES` / `Space` | Space | Owner/member roles, invitations, widget index, layout and AI settings |
| `WIDGETS` / `Widget` | Widget | Content, configuration and bounded retry receipts |
| `SPACE_DIRECTORIES` / `SpaceDirectory` | Builder | Space/invitation indexes, private chat, durable job queue and daily usage |

Each widget has its own SQLite-backed Durable Object. Cross-object updates use persisted operation receipts and reconciliation. The source implements one hibernating WebSocket per open space, with session and membership checks. Local tests verify access revocation and restart behavior.

Application-level deletion/reset is distinct from deleting an entire cloud namespace. The retained source has soft-deleted records, archives, job snapshots and retry receipts with separate lifetimes. Read [data flow and retention](docs/DATA_FLOW_AND_RETENTION.md) before making erasure claims about any future integration.

## Local verification

```sh
npm run check
npm test
npm run build
```

Miniflare tests require loopback networking. They use synthetic identities, temporary local storage and deterministic provider responses. They validate the implementation without contacting a hosted application or billing an inference provider.
