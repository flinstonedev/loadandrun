# Network and public infrastructure corpus review

Reviewed 2026-09-05. Nine proposed experiments are in `networks.json`. Each includes approximately 480–525 words of substantive brief text, primary source material, an explicit account of what already exists, a scoped build plan, success criteria, roles, and challenges.

The entries continue published visions through specific community applications. None claims that its underlying protocol, project, or software has never been implemented. Potential community benefits and the suggested milestones are editorial proposals to test, not findings attributed to the historical authors.

## Reuse evidence

The exact public repository revision and full license file were retrieved for every selected implementation. The copied license text is hashed with SHA-256. These grants cover the selected software under their stated conditions; they do not turn historical papers, trademarks, community data, or independent dependencies into freely reusable material.

| Brief | Selected implementation | Reviewed license | Scope notes |
| --- | --- | --- | --- |
| Community message relay | dtn7-rs | MIT | Selects MIT from the project’s MIT/Apache choice; BP7 is already a standard with implementations. |
| Capability civic services | Cap’n Proto | MIT | Later capability RPC implementation; its own documentation explicitly traces the protocol to E/CapTP. Does not grant rights to E source. |
| Federated local knowledge | Federated Wiki | MIT | Core Node package; client, server, plugins, dependencies, and contributed content keep separate licenses. |
| Cooperative app hosting | Sandstorm | Apache-2.0 | Full license file lists separately licensed bundled works and trademark restrictions. App packages need their own review. |
| Offline mutual aid | ssb-db | MIT | This is the feed storage component, not every SSB application or plugin. Replicated deletion limits are documented explicitly. |
| Community network rehearsal | babeld | MIT | Protocol implementation; the proposed lab is software-only and does not change production routing. |
| Verifiable community archive | IPFS Kubo | MIT | Root license selection notice confirms MIT remains available across its MIT/Apache transition. Stored content is independently licensed. |
| Versioned citizen data | Hypercore | MIT | Later reference library, not a claim of compatibility with archived Dat protocols. Current truncation/fork behavior is acknowledged. |
| Community-owned search | YaCy | GPL-2.0-or-later | COPYRIGHT assigns main code GPL 2 or later, with a designated LGPL cora subtree and individual-file exceptions. Full GPL text is retained. |

## Primary source verification

- DTN: RFC 4838 and RFC 9171 retrieved from the RFC Editor, including author list, historical architecture, prior implementation record, and delivery limitations.
- Capabilities: original E concepts and Cap’n Proto RPC documentation retrieved; the latter explicitly states the CapTP/E lineage and documents capability semantics.
- Federated Wiki: the project’s `Contribute Code` history was retrieved through web search. Direct requests to fed.wiki.org were intermittently unavailable. Ward Cunningham’s preserved Smallest-Federated-Wiki repository is also linked as a stable primary account of the original goals; the current Node package README and license were retrieved at the pinned revision.
- Sandstorm: historical mission/about page, current repository README, full license, and administrative backup documentation retrieved.
- Scuttlebutt: consortium protocol guide and pinned ssb-db README/license retrieved. The proposed application deliberately limits its first pilot to synthetic, non-sensitive coordination data.
- Babel: RFC 6126, RFC 8966, author’s project page, and pinned babeld README/license retrieved.
- IPFS: Juan Benet’s 2014 paper record, official pinning documentation, pinned Kubo README, root license notice, and MIT license retrieved.
- Dat: archived protocol site and author-maintained archived whitepaper retrieved. The whitepaper source at `bcaa3703ac0df22f3e2fa13d47416f1078811eb8/source/dat-paper.md` confirms authors, 2017 publication lineage, dataset synchronization, versioning, and Hypercore’s original role. Its preserved version is dated May 2017, updated January 2018; the archive README records an original April 2017 publication. The brief uses only the unambiguous year 2017.
- YaCy: project’s historical philosophy, Michael Christen’s 2012 ApacheCon presentation, current README, COPYRIGHT, and GPL text retrieved. Broad manifesto claims about anonymity and censorship are treated as aspirations; the actual proposed test is a bounded, locally processed search collection.

## Validation

All nine JSON entries parse. Every section’s source IDs resolve. All implementation commits are 40-character identifiers, embedded license hashes match the saved text, and the required use/modify/redistribute/commercial/royalty-free permission fields are present and true. YaCy uses the unambiguous `GPL-2.0-or-later` identifier supported by the updated catalog policy.
