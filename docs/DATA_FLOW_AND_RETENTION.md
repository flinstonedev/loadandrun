# Data flow and retention

This is a description of application behavior reviewed from source on 2026-09-21. It is not a service privacy policy, a guarantee of complete erasure, or a verification of provider settings. Deployment-specific backup, logging, location, and provider retention settings must be checked separately before accepting additional users.

## Execution modes

The default `npm run dev` demonstration uses synthetic local data and does not enable hosted Spaces, Workers AI, or WorkOS. Treat its data as disposable. The retained Worker adapters and their synthetic tests implement the data-handling behavior below; there is no current hosted deployment. These tables describe what the adapters do when exercised or separately configured, not network activity enabled by the default demo. Browser requests to external resources or links are separate from the demo server's state and must also be considered.

This repository is now code-only. The retained authentication adapters separate Access validation, WorkOS identity and application membership; a matching email is never sufficient to claim another builder's records. The former Cloudflare Worker and its four Durable Object namespaces, including their stored data, were deleted with the owner’s authorization on September 21, 2026. No cloud database or historical user records are included in this source snapshot. The following adapter behavior describes the source and its synthetic tests, not a currently provided hosted service.

## Where data goes

| Data and purpose | Application storage or recipient | Source reference |
| --- | --- | --- |
| Builder ID and name, WorkOS user ID, email and verification status | Community `Workspace` Durable Object, in SQLite records | `server/workos-identity.mjs`, `server/sqlite-store.mjs` |
| Sign-in state, PKCE verifier, WorkOS identity, access/refresh tokens, CSRF value and session expiry | WorkOS during authentication; encrypted session payload in the community Durable Object; browser holds opaque HttpOnly cookies | `worker/authkit.ts`, `server/sqlite-store.mjs` |
| Legacy account password proof during an explicit claim | Verified server-side against retained hash/salt; successful linking removes those legacy credentials from the account record | `server/model.mjs`, `server/workos-identity.mjs` |
| Groups, projects, posts, comments, reactions, bookmarks, idea submissions and reports | Community SQLite records; visibility is checked before app reads | `server/community.mjs`, `server/sqlite-store.mjs` |
| Space title, owner, members, invitations, widget index, AI settings and operation receipts | Per-space `Space` Durable Object; per-builder directory also stores indexes/invitations | `worker/space.ts`, `worker/space-directory.ts` |
| Notes, tasks, links, ideas, repository/video metadata and recommendation contents | Per-widget `Widget` Durable Object, including bounded retry snapshots | `worker/widget.ts` |
| Private chat and queued AI work, including selected context snapshots | Per-builder `SpaceDirectory` Durable Object | `worker/space-directory.ts` |
| Selected widget content and titles, current chat prompt and bounded prior messages | Cloudflare Workers AI through the application's binding | `worker/ai.ts` |
| Derived topic queries, public repository/video identifiers and metadata requests | GitHub; YouTube/Google APIs when configured; YouTube oEmbed and public GitHub README links for related video discovery | `server/content-search.mjs`, `server/discovery.mjs`, `server/github.mjs` |
| Theme preference and unsaved widget drafts | Browser localStorage and sessionStorage respectively | `src/community.js`, `src/spaces.js` |
| Font and thumbnail requests; outbound links | Google Fonts, applicable image hosts, and destinations opened by the user | `src/index.html`, `src/spaces.js` |

The session table uses a hash of the browser token as its lookup key and AES-GCM for the session payload, with a key derived from that token. This is a specific session-store protection, not end-to-end encryption of notes, chats, or community records. Application code can read those records and send authorized AI context onward. Provider secrets are configuration, not a source-code fixture.

Cloudflare Access verifies the deployment token before routing requests. The community RPC receives the app session rather than the Access identity. That separation does not mean Cloudflare's infrastructure or WorkOS has no authentication or request metadata.

## AI selection and consent

Private chat is initiated by an authenticated member. The app sends the current message, selected space title/widget content, and bounded chat history to Cloudflare Workers AI. It selects widgets with `includeInAI`, excludes recommendation results from source context, and applies size limits. It does not automatically send the entire community database.

Shared recommendations require the space owner's AI consent; automatic runs also require the automatic-recommendation setting. **The shared recommendation consent setting is not a global block on member-initiated private chat.** Context and membership are checked again before queued work runs and before results are applied. Revoking consent or changing context cancels or invalidates applicable work, but cannot retract a request already received by a provider.

Recommendation discovery first sends included context to Workers AI to produce short topic phrases. The app filters some URL, email, and token-like patterns, then searches external providers and asks Workers AI to rank returned candidates. The prompt asks for generic phrases; this and the pattern checks are not complete personal-data detection. Provider search requests can reveal topics derived from private content. Optional provider credentials are sent to their respective APIs from the server.

The app does not configure or prove a provider-wide zero-retention or no-training promise. Check current provider terms and account settings before making either claim. The local demo does not exercise these provider calls.

## What is retained and what removal does

| Record | Behavior in this source revision | Limitation |
| --- | --- | --- |
| Application sessions | Seven-day application expiry; OAuth attempts expire after ten minutes. Expired sessions are rejected. Session writes prune expired rows; logout removes the current app session and clears its cookie. | Expiry is not a guaranteed deletion time for an idle database. Provider sign-out/session retention is separate. |
| Legacy-claim rate limits | Hashed lookup keys and attempt counts; entries older than fifteen minutes are pruned when another attempt is recorded. | No independent timer promises physical deletion at fifteen minutes. |
| Builder and community records | No general age-based retention or account-erasure workflow is implemented. Removing a post sets `deleted = true`, hiding it from reads. Reaction/bookmark toggles remove their corresponding records. | A removed post's body and associated comment/reaction records can remain stored. Logout does not delete an account or its content. |
| Current private chat | At most sixty messages are kept per builder/space; context changes can start a fresh conversation. Reset deletes the current `chat:` record and cancels chat work. | No age-based TTL for the current conversation. Reset does not delete the separate archive or terminal job snapshots. |
| Retired-provider chat archive | The hosted-AI migration moves old messages into a separate archive without feeding them automatically to the new provider. | No general age-based archive expiry. Ordinary chat reset does not clear the archive. |
| AI jobs | Jobs store prompts, context/history snapshots, status and temporary progress. Terminal jobs are eligible for alarm cleanup seven days after finishing; interrupted running jobs have a three-minute recovery deadline. | The deadline is job state handling, not retention. Cancelled/completed job snapshots may outlive chat reset, widget edits, or space deletion. Alarm execution is not an exact deletion-time guarantee. |
| AI usage counters | Daily counters older than the seven-day retention cutoff are removed during directory alarms. | Old counters may remain if no alarm subsequently runs. |
| Widget updates | Current content plus up to two hundred operation receipts containing full widget snapshots. Old receipts are trimmed during subsequent writes. | Editing out sensitive text does not immediately remove earlier receipt copies. Receipts have no time-based TTL. |
| Widget deletion | Removes widget state/receipts and retains a tombstone with space ID and deletion time to prevent delayed retries recreating it. | Pending cross-object cleanup, earlier AI snapshots, browser drafts and provider copies are separate. |
| Space deletion or membership removal | Access is revoked; space deletion clears member/invitation/widget indexes, queues child cleanup and cancels work in affected directories. Cancelling all context also clears current/archived chat there. | Deleted space metadata, including title/owner and some operation records, remains. Cross-object cleanup can need retries. Terminal job snapshots are retained until their own cleanup. |
| Discovery caches | Public provider metadata normally has a fifteen-minute cache TTL. Rate-limit cooldowns use separate provider-derived expiry. Query/credential cache keys use digests; cached results omit private prompts and recommendation reasons. | Cache freshness is not a physical-erasure guarantee. A digest is not anonymization of a guessable query. Provider-side request retention is separate. |
| Browser state | Theme persists in localStorage. Dirty widget drafts use sessionStorage keyed by builder/space/widget; a clean saved draft removes its entry. | There is no blanket logout-time draft purge. Browser session restore may retain sessionStorage; users can clear site data. |

The old document product has a targeted retirement migration in `server/sqlite-store.mjs` that removes its former record collections and key fields. It deliberately preserves community accounts and participation. That migration is not a deletion procedure for the current Spaces product or a complete user-account erasure mechanism.

`src/practice.js` also contains a legacy localStorage-based exercise-notes feature. It is not in the current build's explicit copied asset list. Reintroducing it would require documenting its persistent device storage and reset behavior.

## Logs, backups, and remaining release work

The code emits selected authentication diagnostics and generic operational errors. Some top-level unexpected-error handlers stringify an error; this document does not guarantee that every possible error is free of sensitive fields. Do not add raw request, cookie, provider token, chat, or widget logging. Review actual log output with synthetic failures and configure provider log access and retention deliberately.

Cloudflare storage recovery/backups, edge logs, WorkOS records, provider inference/search logs, browser caches, screenshots, downloads and exports are outside the application deletion paths. No retention duration, region, or purge guarantee for those systems was verified here. Removing repository files also does not remove prior Git history or previously distributed artifacts.

If a separately authorized future service is ever proposed, first define and implement an account export/erasure process; decide how to purge soft-deleted content, archives, job snapshots and retry receipts; verify cross-object cleanup; set and verify backup/log/provider retention; and publish a deployment-specific privacy notice. Test those promises against actual behavior. Until then, describe deletion and retention with the limits above rather than claiming immediate, complete or automatic erasure.
