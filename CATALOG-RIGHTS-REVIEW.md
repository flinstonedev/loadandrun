# Catalog rights review and publication decisions

Reviewed 5 September 2026. All nine original catalog entries were screened. **Two retain a specific licensed implementation path; seven are held out of the public catalog.** “Held” means insufficient evidence for this publication rule, not a finding that independently implementing the idea is unlawful.

## Publication rule

Require identifiable released code, an explicit license allowing royalty-free commercial use, modification and redistribution, and substantive source material. Show the exact implementation and license conditions beside the idea. An article, an expired patent, an installer, or a repository with a similar name is not by itself a licensed implementation of the catalog entry.

This is a conservative editorial decision supported by the inspected materials. It is not a 100% guarantee, legal advice, or a worldwide freedom-to-operate opinion. It does not clear unrelated third-party patents, trademarks, or assets. Copyright on a paper does not automatically prohibit implementation of its ideas; see the [U.S. Copyright Office’s distinction](https://www.copyright.gov/circs/circ33.pdf). The catalog makes the narrower claim that a specified software release has documented reuse terms.

## Kept with a specific implementation

### 1a — Open Hyperdocument System, via HyperScope 1.1

The [official download page](https://hyperscope.org/download/index.html) links to Brad Neuberg’s repository. Its [release license](https://github.com/BradNeuberg/hyperscope/blob/f979f3fb8014c162ecc1ff06ea2ec45a44c3cb32/release1_1/LICENSE) is GPL-2.0. Commercial use and modification are permitted under its conditions; distribution of derivatives entails GPL/source obligations. This is not permission to incorporate GPL-covered code into a proprietary distributed derivative.

Checked bundled runtime terms: [Dojo](https://github.com/BradNeuberg/hyperscope/blob/f979f3fb8014c162ecc1ff06ea2ec45a44c3cb32/release1_1/src/client/lib/dojo/LICENSE) offers modified BSD or AFL-2.1, subject to per-module exceptions; its crypto notice identifies BSD terms. [Sarissa 0.9.7](https://github.com/BradNeuberg/hyperscope/blob/f979f3fb8014c162ecc1ff06ea2ec45a44c3cb32/release1_1/src/client/lib/sarissa/core.js) offers GPL-2-or-later, LGPL-2.1-or-later, or Apache-2-or-later. Preserve applicable notices and choose compatible terms. This check does not certify every historical demo asset or bundled development tool.

Use the software path with your own content and branding. [Institute papers and media](https://dougengelbart.org/content/view/210/) have separate terms. The [original OHS paper](https://dougengelbart.org/content/view/114/) remains a reference link. The archived implementation needs compatibility work; its maintainer does not claim it runs in current browsers.

### 1c — Transclusion, via Udanax Green

The [archived original rights-holder grant](https://github.com/dotmpe/udanax-1999-09-29/blob/5e9fce82cf89e6ed09034c6e01e77228a6c8429b/license.html) covers the released Green/Gold code under MIT X-11 and states that the company relied on trade secrets rather than patents. Keep notices and respect its branding restriction. This statement does not clear unrelated third-party patents.

The [original distribution README](https://github.com/dotmpe/udanax-1999-09-29/blob/5e9fce82cf89e6ed09034c6e01e77228a6c8429b/README) includes build instructions and a permission notice. This provides stronger evidence than relying only on the later Java translation’s top-level MIT badge. The [released source](https://github.com/dotmpe/udanax-1999-09-29/tree/5e9fce82cf89e6ed09034c6e01e77228a6c8429b) is the published starting point.

Rights in material displayed by a transclusion system are separate. Use content you own or have permission to display; [transcopyright](https://xanadu.com/xuTco.html) does not automatically apply to arbitrary third-party content. Do not reuse protected project logos or imply endorsement.

## Held entries

| Entry | Evidence examined | Decision basis |
|---|---|---|
| 1b Trails | [Bush’s essay, authorized reproduction](https://www.w3.org/History/1945/vbush/vbush.txt) | Source material exists, but no identified original code release and reuse grant. A newly authored trails implementation may be possible; that is distinct from the licensed-code publication rule. |
| 2a Conversational teaching machines | [Pask apparatus patent](https://patents.google.com/patent/US2984017A/en); [CC BY 4.0 research article](https://discovery.ucl.ac.uk/id/eprint/10196048/) | The identified U.S. patent is reported expired. The article’s license covers that article, not every teaching-machine implementation. The broad entry also combines an early skill-training apparatus with later conversation theory. |
| 2b Dynabook | [1972 paper](https://mprove.de/visionreality/media/kay72.html); [current brand terms](https://shop.us.dynabook.com/pages/terms-of-service) | No original licensed implementation established; protected branding is a separate issue. [Squeak](https://squeak.org/license/) is a possible separately scoped future entry, not a license to all Dynabook materials. |
| 3a Problem-Knowledge Couplers | [Original author’s book](https://link.springer.com/book/10.1007/978-1-4612-3150-9), [research paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC226622/), [rights-holder acquisition announcement](https://about.sharecare.com/press-releases/sharecare-announces-acquisition-pkc-corporation/) | Original implementation and clinical knowledge base were commercial assets; no open-software or database grant established. |
| 4a Pygmalion | [198-page Stanford report](https://worrydream.com/refs/Smith_DC_1975_-_Pygmalion.pdf), including scanned cover and front matter | Public-release/unlimited-distribution marking does not establish commercial modification rights in the original software and illustrations. No licensed original source release established. The similarly named [crd1 repository](https://github.com/crd1/pygmalion) is an unrelated mock-HTTP tool and was rejected as evidence. |
| 4b PIE | [58-page CSL-81-3 report](https://worrydream.com/refs/Goldstein_1981_-_PIE_four_reports.pdf) | Page 2 identifies Xerox Corporation 1981 copyright. Reports describe the system but no original licensed software release was established. |
| 4c Play-in / play-out | [Book](https://www.wisdom.weizmann.ac.il/~playbook/Updates/ComeLetsPlay.pdf), [2016 update](https://www.wisdom.weizmann.ac.il/~playbook/updates.html), downloaded ZIP contents, [US application](https://patents.google.com/patent/US20040205703A1/en), [related US grant](https://patents.google.com/patent/US7213230B2/en) | The ZIP contains one MSI installer. Removing license-number requirements is not an explicit source modification/redistribution grant. The cited application is listed as abandoned and the grant expired-fee-related, with adjusted expiry 2022-03-19. Those aggregator records do not constitute global clearance. Hold is based on unresolved software reuse rights, not an asserted active patent. |

## Evidence and product enforcement

- [Structured review](research/catalog-rights.json): decisions, reasons, source material, precise implementation/license URLs and public scope notes.
- [Evidence index](research/rights-evidence-index.json): retrieval dates, file sizes and SHA-256 fingerprints for inspected archives and notices. PDFs and executable archives were inspected locally, not redistributed or executed.
- [Research archive](research/catalog-archive.json): all original entries and directory records retained outside public assets.
- The generator publishes only entries explicitly marked `publish` with a code URL, license URL and source material. The public People directory links only to retained entries.
- The source’s legacy Workspace retirement migration deletes its document/journal/inbox/presence collections while preserving the separate community collections; synthetic tests exercise that migration. This is historical implementation behavior, not a claim that cloud records are still retained: the former Worker and its four namespaces were subsequently deleted. The research archive above is editorial source material, not user storage.
- Tests cover publication filtering, source requirements, archival without personal-data changes, stable reference addresses, and idempotent synchronization.

No rights holders were contacted and no new permissions were obtained. Revisit held entries when an original grant, a suitably licensed implementation, or a narrower independently implemented project can be positively documented.

## Product presentation and enforcement

Catalog cards and idea pages expose a consistent license control. It opens a plain-language permissions panel with the full reviewed license text and links to the original notice and exact code release. The badge always names the license; it does not mean condition-free use or license user-authored community content.

`src/catalog-policy.js` is used by generation, build validation and browser filtering. Publication requires an approved review, a currently supported reviewed license, explicit free-use/commercial/modification/redistribution grants, source material, HTTPS evidence links and visible scope/conditions. Missing or restricted grants fail closed. Contribution references and People discovery stay scoped to eligible catalog entries. The source’s catalog update path preserves community records in local migration tests; no hosted user dataset is distributed.

## Community library expansion

The two retained historical entries now sit alongside 12 separately reviewed proposed experiments in `research/community-ideas.json`. Their implementation licenses are MIT, Apache-2.0, or CC0-1.0, with exact pinned notices and scope. The seven original held entries remain held. New proposals explicitly name existing work; no entry claims a global absence of prior implementations. See `research/community-ideas-review.md` and `COMMUNITY.md`.

## Detailed corpus expansion

The public corpus now contains 41 detailed revival opportunities: 14 expanded existing entries and 27 additional briefs in `research/expanded/`. Each new brief has pinned source/license evidence, scoped permissions and original-source references. Modern building-block licenses support independently authored implementations and do not license historical proprietary artifacts. The seven original withheld implementations remain withheld. Additional notices are retained in the UI. See `CORPUS.md` and the batch research notes for exclusions, history distinctions, and maintenance.
