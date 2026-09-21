# Knowledge corpus research notes

Reviewed on 2026-09-05. Nine proposed community experiments, each grounded in retrieved primary sources. The historical visions/prototypes and modern implementation libraries are separate. A library license grants rights to its own code; it does not license a historical paper or establish ownership of an abstract idea.

## Selection and history

- Memex: the 1945 source proposes named associative trails, branches, notes, and exchange. The entry labels the mechanical/personal-machine concept as a vision and acknowledges modern annotation implementations.
- Microcosm/OHP: the retrieved Southampton paper explicitly describes working prototypes and commercial systems, then proposes cross-service interoperability. The entry revives this concrete interoperability question.
- VIKI: the author-hosted abstract and precursor paper document a working spatial hypertext system and heuristic structure recognition. The community board is a proposed extension, with human confirmation and reversible interpretation.
- Lifestreams: the Yale project page documents the personal-information prototype, related commercial efforts, and an enterprise direction. The entry does not claim streams or chronological interfaces were never built.
- NEPOMUK: DFKI describes the 2006–2008 project, delivered framework, and cross-application/social exchange goals. The proposed experiment concerns a human-readable boundary for sharing a selected graph.
- Fresnel: the W3C-hosted project and manual list historical implementations and describe the goal of reusable presentation knowledge. The new work is a limited, testable, accessible interoperability profile.
- Web Annotation: the W3C Recommendation and implementation report provide evidence that the model and applications exist. The new work is a precise community migration exercise, including identity and visibility limitations.
- Haystack: the MIT papers describe an implemented RDF platform and cooperative tools. The proposed event kit tests replacement of one independently developed tool.
- Placeless Documents: the journal source and author-hosted reflection describe a working prototype. The new work tests understandable overlapping views and reversible metadata rules.

ZigZag was investigated but omitted. The historical project has explicit patent/trademark history. The identified US6262736B1 is listed as expired by lifetime in Google Patents, but a secondary status page is not a worldwide clearance. Fresnel is a better fit for this batch.

## License verification

Public GitHub commit metadata was requested with an upper timestamp of 2026-09-05T00:00:00Z. Complete pinned license files and READMEs were retrieved through the public API; Annotator’s LICENSE-MIT and AUTHORS were retrieved through raw.githubusercontent.com at the same pinned commit. No private GitHub resources were read.

GitHub returned NOASSERTION for several repositories with extra notices, typography, or multiple license options. These were reviewed by reading the actual grant; NOASSERTION was not treated as a license. The JSON stores the exact retrieved license text and its SHA-256 digest.

| Building block | Reviewed license | Commit | License text SHA-256 |
|---|---|---|---|
| [Hypothesis client](https://github.com/hypothesis/client/blob/b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a/LICENSE) | BSD-2-Clause | `b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a` | `8000e9f55b3ea757318f072c8fae3640a4f9e2e3b578c6a271ae98b1598eee7f` |
| [Annotator](https://github.com/openannotation/annotator/blob/f4f7c75869f54b046f7ca89492b4c35cfbc162bb/LICENSE-MIT) | MIT | `f4f7c75869f54b046f7ca89492b4c35cfbc162bb` | `89807acf2309bd285f033404ee78581602f3cd9b819a16ac2f0e5f60ff4a473e` |
| [Cytoscape.js](https://github.com/cytoscape/cytoscape.js/blob/fd3595bbf0eaac76ef2a6984a29e85703c239703/LICENSE) | MIT | `fd3595bbf0eaac76ef2a6984a29e85703c239703` | `a29c0d78a54de204b78357976c3d272a573b8592d0478b9db07af3f1da31a65a` |
| [Tantivy](https://github.com/quickwit-oss/tantivy/blob/b5d8deb80c26924e6b007a5b1a7630f35ca64de4/LICENSE) | MIT | `b5d8deb80c26924e6b007a5b1a7630f35ca64de4` | `acacd14bebbffdb30d62443c282fb4da3e81915a9f69c63d5d745a029f44de8a` |
| [RDFLib](https://github.com/RDFLib/rdflib/blob/581d7189991f84fb21e6b89e1a063908276a0bb1/LICENSE) | BSD-3-Clause | `581d7189991f84fb21e6b89e1a063908276a0bb1` | `53a705e51bfd199e8c97d0442376cb4bbd4ffcf13ba4f2c4c2794211400e4012` |
| [N3.js](https://github.com/rdfjs/N3.js/blob/8585618a988b058769e9ea5e506da0b30f1c1cc7/LICENSE.md) | MIT | `8585618a988b058769e9ea5e506da0b30f1c1cc7` | `c865fbe2694190f63fbc44c760a11574f843ca837fa580b332d56d23d5867443` |
| [DuckDB](https://github.com/duckdb/duckdb/blob/e3946f2327a3cc622e1ec7fe71d51de49f93e61d/LICENSE) | MIT | `e3946f2327a3cc622e1ec7fe71d51de49f93e61d` | `075c33400ffcb0c586dd106a029d3e733e9da3693f8fcb9cebfc651c8a2f14e3` |

- Hypothesis client: the main grant is BSD-2-Clause. The full LICENSE also includes an MIT Annotator subcomponent notice; the full file is preserved and the share requirement calls out both.
- Annotator: LICENSE explicitly permits either MIT or GPLv3-or-later. This entry selects MIT, links the explicit choice, preserves the complete LICENSE-MIT text, and links AUTHORS. It does not silently apply GPL obligations to the MIT option.
- Cytoscape.js: the actual grant is MIT despite GitHub NOASSERTION, caused by text differing from the canonical detector form.
- RDFLib: BSD-3-Clause includes the no-endorsement condition. The entry calls it out.
- N3.js: the actual license file grants MIT despite detector NOASSERTION.
- Tantivy and DuckDB: complete MIT grants were retrieved.

All seven unique building blocks permit use, modification, redistribution, and commercial use without a software royalty, subject to their notices. The scope does not cover historical code, brands, linked documents, third-party components, or a patent clearance for all possible products. Proposed trials use participant-created or permissioned datasets; no historical source code is copied into a product.

## Validation

Every entry has three concrete build steps, measurable success criteria, non-goals, contributor roles, practical challenges, primary references, and a license record. Substantive detail text is approximately 492–527 words per entry, excluding source lists and full licenses. Local checks confirmed all sourceIds resolve, IDs are unique, commits are 40 hex characters and appear in source/license URLs, permissions are true, and every full license hashes to its recorded digest.

## Retrieved primary source index

- [As We May Think (1945)](https://www.w3.org/History/1945/vbush/vbush.txt) — Bush’s proposed associative indexing, branching trails, commentary, and exchange between readers.
- [Towards Interoperability in Open Hypermedia Linkservices](https://www.southampton.ac.uk/~hcd/ohp/finalpaper/jodi.html) — Existing open hypermedia systems, their private protocols, and the proposal for interoperable clients and link services.
- [VIKI: Spatial Hypertext Supporting Emergent Structure](https://people.engr.tamu.edu/shipman/abstracts/echt94-abstract.html) — VIKI’s objects, collections, composites, and spatial parser.
- [Searching for the Missing Link: Discovering Implicit Structure in Spatial Hypertext](https://people.engr.tamu.edu/shipman/viki/papers/ht93/ht93.html) — Experiments with recognizing spatial structure and the need for human guidance.
- [The Yale Lifestreams Project Page](https://www.cs.yale.edu/homes/freeman/lifestreams.html) — The stream metaphor, implemented personal-information prototype, related commercial efforts, and the stated enterprise direction.
- [NEPOMUK: Networked Environment for Personalized, Ontology-based Management of Unified Knowledge](https://www.dfki.de/en/web/research/projects-and-publications/project/nepomuk) — The project’s 2006–2008 dates, cross-application and social-exchange ambitions, and delivered open-source framework.
- [Fresnel: Display Vocabulary for RDF](https://www.w3.org/2005/04/fresnel-info/) — The shared-presentation ambition, history, contributors, and list of implemented browsers.
- [Fresnel vocabulary user manual (30 June 2005)](https://www.w3.org/2005/04/fresnel-info/manual/) — The separation of selection and formatting, lens behavior, and support for different output representations.
- [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) — Portable annotations, bodies and targets, selected regions, and the distinction between data model and transport.
- [Web Annotation Model: all implementation results](https://w3c.github.io/test-results/annotation-model/all.html) — Multiple implemented annotations and differences in support for optional features and collections.
- [Haystack: A Platform for Authoring End User Semantic Web Applications](https://haystack.csail.mit.edu/papers/iswc2003-haystack) — Implemented RDF-based platform, structured interfaces, extensibility, and customization.
- [User Interaction Experience for Semantic Web Information](https://haystack.csail.mit.edu/papers/www2003-ui.pdf) — Information-centric navigation, direct manipulation, and the proposal for small cooperative tools.
- [Extending document management systems with user-specific active properties](https://doi.org/10.1145/348751.348758) — The implemented Placeless Documents prototype and its property-based document services.
- [The Appropriation of Interactive Technologies: Some Lessons from Placeless Documents](https://www.dourish.com/publications/2002/jcscw-appropriation.pdf) — The author’s account of document properties, multiple perspectives, and adaptation to working practices.
