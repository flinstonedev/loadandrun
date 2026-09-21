# Community idea references — 5 September 2026

Twelve proposed experiments were reviewed for publication. Each names an existing implementation, links primary source material, and has an explicit positive grant covering the named reference implementation's own code. These are **proposed build opportunities**, not findings that the underlying ideas have never been built.

## Method and scope

- Read the repositories' own descriptions, project pages, and research summaries to establish what already exists.
- Resolve each repository's current default branch to a commit through the public GitHub API.
- Retrieve the actual license file through the GitHub Contents API at that commit; decode and inspect its grant and obligations.
- Store immutable source and license links, the retrieved license text, a SHA-256 digest of that text, and the review date in `community-ideas.json`.
- Keep source-material rights separate from code rights. A linked essay, paper, image, video, brand, dataset, or third-party component is not treated as licensed by the repository's top-level license.

`reviewStatus: approved` means that the referenced material has an explicit grant permitting use, modification, redistribution, and commercial use without a license royalty, subject to the recorded conditions. It is not an exhaustive patent search, a dependency audit, a warranty of production readiness, or a claim of exclusive novelty. Hosting, devices, and external services may cost money.

All twelve JSON records contain non-license primary source material. Each has a pinned implementation README; Cambria, Wildcard, Peritext, Webstrates, and LOOPY also have a project or research source.

## Findings

| Proposed experiment | Existing reference | License | Grant evidence and specific limitation |
| --- | --- | --- | --- |
| A notebook that reunites after a week offline | Automerge | MIT | Actual license explicitly permits free use, copying, modification, distribution, and sale with notices. Automerge already supplies local-first persistence and synchronization; the proposal tests a fieldwork reconciliation experience. |
| Software that survives its own data format | Cambria | MIT | Actual license carries Ink & Switch's permission grant. The documented bidirectional lenses and issue-tracker prototype already exist; the repository describes immature software. |
| Living diagrams that explain their assumptions | Apparatus | MIT | Actual license carries Tobias Schachman's permission grant. Apparatus already creates interactive diagrams; the proposal concerns assumptions and group review. Vendored code and fonts remain separately governed. |
| A personal web repair kit | Wildcard | MIT | Actual license carries Geoffrey Litt's permission grant. The existing prerelease extension is named. The grant does not license other websites' material. |
| A workspace whose tools members can reshape | lively.next | MIT | Actual license carries the Lively Kernel contributors' permission grant. The existing beta programming environment is named; the proposal concerns reviewing and restoring shared tool changes. |
| A project passport you can take between communities | Community Solid Server | MIT | Actual license carries the Inrupt and imec permission grant. Solid Pods and identity already exist. User records and connected applications have separate permissions. |
| Shared writing that preserves disagreement | Peritext | MIT | Actual license carries Ink & Switch's permission grant. The algorithm, editor integration, and tests already exist. Linked essay and paper are research references, with no assumed MIT grant over their text or figures. |
| Small languages for everyday work | Ohm | MIT | Actual license carries Alessandro Warth and contributors' permission grant. The language toolkit and its documented applications already exist. Community recipes and extensions require their own license decisions. |
| Documents that become shared tools | Webstrates | Apache-2.0 | Actual license file applies Apache 2.0 and names Clemens Nylandsted Klokmose, Kristian Borup Antonsen, and Aarhus University. Existing Webstrates, Codestrates, and Varv are acknowledged. |
| Automation recipes people can inspect | Blockly | Apache-2.0 | Actual license file contains Apache 2.0's full copyright and contributor patent grants and conditions. Blockly already supplies a visual editor; service connectors and outside terms are separate. |
| A shared map of how a system might change | LOOPY | CC0-1.0 | Actual license contains the CC0 waiver and fallback, and the creator's README expressly applies it to LOOPY. Third-party code retains separate terms. CC0 excludes patent and trademark rights. |
| A neural network you can argue with | micrograd | MIT | Actual license carries Andrej Karpathy's permission grant. The existing automatic differentiation engine is named. No rights to external model weights, datasets, or videos are asserted. |

## License presentation

- **MIT (nine records):** Show the specific copyright notice and exact license text. Preserve copyright and permission notices in copies or substantial portions. The license permits commercial use and sale.
- **Apache-2.0 (two records):** Show the license, retain applicable notices, identify modified files, and preserve required NOTICE content. Its contributor patent grant is scoped by its terms; it does not grant trademark rights.
- **CC0-1.0 (one record):** Identify it as a public-domain dedication with a fallback license. Attribution is not imposed by CC0 for the creator's material. Separate third-party notices still apply, and patents/trademarks are excluded.

Webstrates' upstream `LICENSE` is the short Apache application notice, not the complete terms. Its record therefore preserves that exact notice in `licenseText` and additionally supplies the complete Apache terms in `licenseTermsText` (the identical standard terms retrieved from the pinned Blockly license), plus the Apache Foundation's `licenseTermsUrl`. A full-license panel should display `licenseTermsText || licenseText` and the specific notice.

The catalog should describe the reference as **free to build with, under its license**, with the license label and conditions nearby. Avoid “100% unrestricted,” “never built,” or treating software permission as permission to republish every linked source.

## Validation

The JSON parses successfully and has twelve unique IDs. Every record includes primary source material, `originalityStatus: proposed-experiment`, a 40-character pinned commit, retrieved license text, a SHA-256 digest, an explicit license identifier, scope, obligations, review date, and affirmative scoped reuse permissions. Counts: nine MIT, two Apache-2.0, one CC0-1.0.
