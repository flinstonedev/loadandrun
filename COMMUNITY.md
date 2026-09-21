# Load and Run community implementation

Load and Run brings builders together around ideas worth exploring. The first community release adds a feed, open groups, projects, and GitHub repository links around a library of 41 detailed, sourced ideas. It preserves the original monochrome, square-edged visual identity.

This is a code-only repository with an offline community demo. The descriptions below cover the retained implementation and synthetic tests, not a running service. “Public” describes a record’s application visibility; it does not publish local demo data to the internet. The former Worker and its four Durable Object namespaces were deleted with their stored data.

## The product loop

1. Browse the idea library, inspect the sources and license terms, and choose a concrete experiment.
2. Sign in with WorkOS AuthKit and choose a builder name, or connect an existing builder account, to save the idea, join a group, or start a project.
3. Give the project a goal and state where help is needed. Projects can be independent or belong to a group the creator has joined.
4. Link public source code on GitHub. Use project discussions for coordination and GitHub for code contributions.
5. Share progress or ask for help. Choose a members-only discussion or an explicitly public update.

The feed's **Explore** view includes updates the current viewer can read. **Your groups** narrows that view to joined groups/projects and the builder's own posts. It is a chronological feed; it does not rank content algorithmically or invent activity.

## Access model

In this table, **visitor** means an unauthenticated app identity in the retained access model. **Builder** means an authenticated app identity; the offline demo uses a fictional builder. Group and project ownership apply to the relevant resource, not the whole platform.

| Action | Visitor | Builder | Group/project member | Owner |
|---|---|---|---|---|
| Browse/search ideas; inspect source material and licenses | Yes | Yes | Yes | Yes |
| Read public updates, comments, group pages, project pages, and repository links | Yes | Yes | Yes | Yes |
| Save ideas and view personal saved ideas | No | Own saves | Own saves | Own saves |
| Post a general public update or request for help | No | Yes | Yes | Yes |
| Comment on, react to, or report a visible post | No | Yes | Yes | Yes |
| Create a group or independent project | No | Yes | Yes | Yes |
| Join an open group | No | Yes | Yes | Already joined |
| Create/join a project within a group | No | Must join the group first | Group members may create/join | Group owner may participate |
| Read or post a members-only group discussion | No | No | Group members | Group owner |
| Read or post a members-only project discussion | No | No | Project members; must also belong to its hosting group | Hosting group owner also has access |
| Change project goal, help needed, stage, or repository link | No | No | No | Project owner or hosting group owner |
| Remove a visible post | No | Own posts | Own posts | Relevant group/project owner may also remove it |
| Submit an idea with source and license evidence | No | Yes; submission stays pending | Yes; submission stays pending | Same submission process |

All groups are open to joining in this release. Group/project descriptions, membership counts, and membership identities are directory information; membership itself is not private. Post visibility is separate. A group member does not automatically become a member of every project in that group.

Public posts are readable and commentable by registered builders outside their group. Members-only project posts require project membership as well as membership in the hosting group. The hosting group owner can read and moderate them. Private post content, comments, reactions, and post counts are filtered on the server before responses reach an outsider.

The owner must remain in their group. Other members can leave; leaving revokes access to group discussions and member-only discussions in its projects. Project ownership remains recorded, including permission to manage that project's settings and repository. Owners can rejoin the open group to participate again. A post's author or relevant owner can remove it; removal is stored as a tombstone.

## Idea library and publication

The 41 entries are documented **revival opportunities and proposed continuations**, not a claim that their surrounding technologies have never been built. Each entry distinguishes a direction to explore from existing work. Existing systems can provide a licensed starting point for a new experiment.

Every published entry includes source material and reviewed reuse information for a specific implementation or release. The UI shows the license, its scope, relevant obligations, and links to the source code and license evidence. A software license does not automatically cover historical papers, third-party content, media, or branding associated with an idea.

Publication is controlled by the reviewed catalog data and the shared eligibility check in `src/catalog-policy.js`. Server-side project, post, and bookmark references are checked against published idea addresses. Submitting a source URL or a familiar license name does not publish an idea or bypass review.

Idea submissions contain a title, summary, HTTPS source-material URL, and HTTPS license-evidence URL. They are stored in `ideaSubmissions` with status `pending` and are not exposed in the public library or community feed. This release has no submission-review or approval UI. Editorial review and publication remain a separate operator workflow. See [the catalog rights review](CATALOG-RIGHTS-REVIEW.md) and [research notes](RESEARCH.md) for the evidence process.

## Projects and GitHub

A project has a goal, an optional catalog idea or original idea, an optional group, members, help-needed text, and stage: **forming**, **building**, **testing**, or **shipped**. Stages are owner-maintained descriptions, not proof of progress or automatic interpretations of repository activity.

The project or hosting group owner can link a public `https://github.com/owner/repository` URL. The source includes an adapter that fetches public metadata and caches the repository's canonical identity, description, language, detected license, archive state, and retrieval time. The offline demo disables this lookup; tests supply deterministic responses. Repository settings are checked again after the network request, before the metadata is saved.

A linked repository is a reference supplied by a project maintainer. It does not verify ownership, connect a GitHub account, or grant collaborators access. The repository's own permissions still govern contributions. Detected license metadata is not catalog rights approval; contributors must inspect the linked repository's license terms.

There are no private repository connections, synchronized issues or pull requests, scheduled refreshes, or GitHub webhooks in this release. Issues and pull requests open on GitHub. A future GitHub App can add authenticated repository selection, permission verification, and selected activity synchronization; that integration is not installed or authorized by linking a public URL.

## Identity adapters

The retained Access and WorkOS adapters implement separate deployment-gate and builder identities. Access claims do not create users or grant membership. Local integration tests exercise these paths with synthetic identities. Workers AI is unbound and disabled; neither the demo nor CI makes paid inference calls.

WorkOS replaces the proposed Clerk integration. Hosted AuthKit manages sign-in, registration, and email verification. The app exchanges the authorization code with PKCE, validates the WorkOS session, and gives the browser an opaque HttpOnly cookie. WorkOS access and refresh tokens stay in encrypted server-side session storage. The keyless PKCE flow does not require a WorkOS API key; an optional server-only `WORKOS_API_KEY` can be configured for an environment that requires one.

On first sign-in, a user chooses a unique builder name or explicitly connects an existing builder by entering its old username and password. Connecting retains the original application UUID, so community ownership, memberships, saved ideas, and spaces keep their references. The old password hash and salt are removed after a successful connection. Existing accounts are never matched automatically by name or email, and a WorkOS identity cannot be linked to more than one builder. The app no longer contains custom username/password registration or login handlers; the old password is used only to prove ownership during account connection.

WorkOS establishes identity. Community and space permissions remain authoritative in the application's Durable Objects. WorkOS organizations or roles do not automatically create memberships or grant access. Shared-space invitations continue to use builder names and in-app acceptance; this release does not use WorkOS organization invitations. This is now a code-only project. Optional local authentication testing uses the contributor's own WorkOS Staging project. Production authentication is not configured by this repository; no historical identity links or user database is included. The former cloud Worker and its four namespaces have been deleted.

A future hosting decision requires separate explicit authorization. Do not add deployment workflows or remote provisioning during normal source changes. See [Cloudflare source and local testing](CLOUDFLARE.md).

## Storage, verification, and release limits

Accounts and community records live in a SQLite-backed Durable Object. Community collections are `groups`, `projects`, `posts`, `comments`, `reactions`, `bookmarks`, `ideaSubmissions`, and `reports`. Mutations use synchronous transactions. Repository metadata is fetched outside the transaction; authorization is checked again inside it.

The whole community is currently coordinated by one configured Durable Object. Reads materialize its records, and the aggregate feed is not paginated. This is the prototype storage model; indexed reads, pagination, and larger-scale distribution remain future work. The retained class/binding identities and migration definitions are exercised using temporary local data; they do not indicate that the former hosted dataset still exists.

Run the standard local checks:

```sh
npm run check
npm test
npm run build
```

The community tests cover account requirements, membership and owner permissions, private content/count filtering, repository authorization after fetching, pending submissions, and persistence. The Cloudflare runtime tests exercise actual HTTP sessions and verify community data and permissions after a Durable Object restart.

Reports are stored in a pending queue, without a moderation console or notifications. Submission and report handling need an operator workflow before an unrestricted community launch. There are also no direct messages, invitations/approval-based groups, delegated moderators, ownership-transfer controls, private group directories, or automatic GitHub access grants. Community membership does not grant GitHub access.

## Detailed corpus

The repository contains 41 briefs across eight topics. Every brief includes original authors/work/date, sourced implementation history, an explicit remaining opportunity, proposed present-day beneficiaries, a first milestone, build steps and deliverables, success criteria, non-goals, team roles, challenges, related work, and claim-linked references. History labels distinguish unrealized visions, research prototypes and unfinished directions. The project form can start from the brief’s first milestone. See `CORPUS.md` for editorial rules and maintenance.
