Programming corpus review — 2026-09-05

The nine entries in `programming.json` are proposed modern experiments with documented antecedents. Existing systems are named and acknowledged. Their proposed work is not described as historical functionality that was never implemented. Each brief contains approximately 445–483 words in its main detail fields, in addition to its card summary, opportunity, references, and license information.

License evidence was retrieved from the upstream repositories using the GitHub API, decoded from the actual files, pinned to full commit hashes, and hashed with SHA-256. The final JSON validates every section reference ID, license digest, commit URL, positive permission field, and three-step build plan. Editorial QA independently checked the reference IDs and digests; its requested BSD3 conditions and grammar corrections were applied.

Scope decisions:

- Boxer Sunrise: BSD-3-Clause. The full historical desktop application requires a paid LispWorks license to build distributable binaries. The proposed foundation is the separately documented Boxer core, for which the README gives SBCL/ECL test commands and an ECL embedding route. The first milestone explicitly establishes the free runtime and replaces missing interface code. No claim was made that this research pass compiled the core or that the full historical application is freely buildable unchanged. Original Scratch-derived icons are excluded from the proposed new interface.
- Light Table: MIT. The owner archived the repository in 2022. Its inline-evaluation implementation is a source foundation; updating its obsolete runtime/dependencies is explicit implementation work.
- Eve: Apache-2.0. The website distinguishes its implemented environment from later research/prototype milestones, and the repository labels v0.3 as no longer actively developed. ATTRIBUTIONS.md was inspected for separately licensed dependencies.
- Unison: MIT for the main project, with BSD-3-Clause for bundled Data.Relation. The actual supplementary license appears in `implementation.additionalNotices`. The entry excludes a blanket claim over Unison Share libraries or the paid cloud service.
- Plan 9: uses the separately MIT-licensed `9fans/go/plan9` packages, avoiding the heterogeneous licensing of a complete historical Plan 9 distribution.
- OberonEmulator: ISC. `OTHER-NOTICES.txt` contains the Project Oberon permissive software/documentation grant and SIL OFL for bundled Font Awesome material. The complete notice text is retained in `implementation.additionalNotices`; the proposed new UI can use original icons. Root confirmed ISC is eligible for the reviewed allowlist.
- Lamdu: GPL-3.0, with corresponding-source requirements for distribution. Its already implemented internationalization and continued preview status are explicit.
- NoFlo: MIT. Its existing editor/test/trace ecosystem is acknowledged, as is Morrison’s distinction between classical FBP and FBP-inspired systems. The pilot uses original components and synthetic or separately licensed data.
- Hazel: MIT. Its actual incomplete-program semantics, continuing collaboration research, and 2026 typed-table work are acknowledged. The planetary-computing paper is treated as a proposed vision with a mockup.

Candidates deliberately excluded:

- [Subtext 10 LICENSE.txt at 5f6d7508f019968962bfadcda1e246c0ab66a27b](https://github.com/JonathanMEdwards/subtext10/blob/5f6d7508f019968962bfadcda1e246c0ab66a27b/LICENSE.txt) specifies CC BY-NC-SA 4.0 and therefore does not meet the commercial-use criterion.
- Sketch-n-Sketch has [MIT text in LICENSE.md](https://github.com/ravichugh/sketch-n-sketch/blob/d69577e27049059fb6b701d4f71548bc25adb07b/LICENSE.md), but its [NOTICE at the same revision](https://github.com/ravichugh/sketch-n-sketch/blob/d69577e27049059fb6b701d4f71548bc25adb07b/NOTICE) contains academic noncommercial restrictions and restrictions on modification/redistribution. That unresolved conflict is enough to exclude it from this catalog; no interpretation overriding either file was assumed.

Useful original sources beyond repository documentation include the Plan 9 authors’ namespace paper, Morrison’s own FBP history, Wirth’s Project Oberon book/source site, the Hazel 2017 foundations and 2024 planetary-compute papers, the Boxer project’s computational-literacy statement, and Paul Chiusano’s 2018 Unison presentation establishing its 2013 research origin.
