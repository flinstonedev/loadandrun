# Rights and third-party notices

The [MIT license](LICENSE) covers original Load and Run application software and its original software documentation. It grants only rights held by the contributors. It does not change the terms of third-party dependencies, catalog materials, quotations, reproduced notices, design references, external services, trademarks, or user content.

## Catalog and research material

`src/data.json` and the files under `research/` combine original editorial work with references, historical descriptions, software-license evidence, and sometimes reproduced notices. They are not offered wholesale under the application MIT license. This release makes no separate blanket license grant for the catalog or research corpus. An entry's software reuse metadata describes the identified implementation or building block, not the entire entry or historical work.

- Follow each entry's pinned `codeUrl`, `licenseUrl`, notice, scope, permissions, and share requirements. Preserve the original notices and review the exact release before reusing its code.
- `src/license-texts.js` contains reproduced GPL-2.0 and Udanax rights-holder text. Other catalog records include additional license and third-party notices. These texts retain their own terms and attribution; the application MIT license does not replace or permit alteration of them.
- Links to papers, books, videos, historical software, images, and datasets do not grant redistribution rights. A modern library's license does not license the historical system it helps recreate.
- The catalog's eligibility filter is an editorial control, not a worldwide patent, trademark, copyright, or freedom-to-operate clearance. In particular, an approved entry does not eliminate copyleft or notice obligations.
- User-created posts, comments, projects, notes, and other hosted content are not licensed by this repository. Use synthetic content in demonstrations unless publication permission has been obtained.

See [catalog decisions](CATALOG-RIGHTS-REVIEW.md), [corpus scope](CORPUS.md), and [structured historical review](research/catalog-rights.json). The held historical entries remain research records, not approved implementation grants. Exclusion from the website build does not itself clear a file for publication in a source repository.

## Dependency inventory

The following is an inventory of the direct dependencies and their license declarations in `package-lock.json`, reviewed on 2026-09-21. It is not a complete transitive dependency notice bundle or an independent verification of every package's contents.

| Package | Locked version | Declared license |
| --- | --- | --- |
| `@workos-inc/node` | 10.13.0 | MIT |
| `jose` | 6.2.11 | MIT |
| `@cloudflare/workers-types` | 5.20260904.1 | MIT OR Apache-2.0 |
| `@types/node` | 26.4.1 | MIT |
| `esbuild` | 0.28.2 | MIT |
| `miniflare` | 5.20260918.0-alpha | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `wrangler` | 4.135.0 | MIT OR Apache-2.0 |
| `ws` | 8.21.0 | MIT |

The first two are runtime dependencies; the remaining packages are development dependencies in the manifest. Preserve applicable package `LICENSE`, `NOTICE`, and copyright files when distributing their code, including dependencies bundled into a Worker or other release artifact. Before distributing a binary, bundle, container, or vendored dependency tree, generate an inventory from that actual artifact, verify transitive terms, and include its required notices. A link or the table above is not a substitute for required license text.

## Fonts, external resources, and design provenance

The application HTML requests IBM Plex Sans and IBM Plex Mono from Google Fonts. Those font files are externally served rather than included in this source tree. Their use and any future self-hosted copies require the applicable font license and attribution; retrieve and preserve the exact font distribution's notice before bundling it. Linked project and video metadata, thumbnails, names, and logos retain their owners' rights. No endorsement is implied.

Legacy design reference HTML and its generated `support.js` runtime are excluded from this source distribution. The runtime identifies itself as generated from `dc-runtime/src/*.ts`, but its corresponding source and a redistribution grant have not been established in this review. The reference HTML also used externally loaded fonts, and the runtime referenced React, React DOM, and Babel from a CDN. Those dependencies do not establish permission to redistribute the generated runtime or design assets.

Do not restore those legacy assets to a public repository, package, or demo until their origin and redistribution terms are documented, or replace them with independently authored assets. The current application build copies an explicit list from `src/`; it does not require the legacy design runtime. Quarantine resolves accidental inclusion, not the underlying provenance question.

Cloudflare, WorkOS, GitHub, YouTube, and other provider services have separate terms. The software license grants no provider account, service entitlement, trademark permission, or access to a hosted service. No service is provided by this repository.

## Release review

Before publication, confirm contributors have the right to license the original application, review every distributed catalog notice and any quotations or copied material, complete the artifact-specific dependency inventory, and keep unresolved assets excluded. Record new third-party imports here with their source revision, license, notice location, and modifications. These checks remain necessary after future dependency or catalog changes.
