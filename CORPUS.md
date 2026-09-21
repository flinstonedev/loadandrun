# The Load and Run idea corpus

The published repository contains **41 detailed briefs**: the previous 14 have been expanded, and 27 additional ideas have been researched. Topics cover knowledge and memory, programming tools, learning and access, collaboration, data and science, personal computing, visual computing, and resilient infrastructure.

## What an entry means

The corpus helps communities continue valuable computing ambitions. It does not claim that all underlying systems were never built. History labels make the distinction visible:

- **Unrealized vision:** the documented overarching proposal was not delivered as described.
- **Research prototype:** a limited working system established parts of the approach.
- **Unfinished direction:** working systems exist, while the brief proposes a specific further experiment.

These labels describe the evidence presented, not a comprehensive proof that no related implementation exists anywhere. Each brief names existing work and separates factual history from the community project being proposed. Prospective benefits are hypotheses to test, not promised social outcomes. The history filter lets readers choose the kind of opportunity they want to investigate.

## Depth and evidence

Every published entry must include:

- The original work, authors, date, and primary sources.
- What was implemented, with citations, and the narrower opportunity to explore.
- Why the direction could matter today and who could benefit.
- A concrete first milestone, at least three build steps with deliverables, and measurable success criteria.
- Non-goals, complementary team roles, and at least two substantial challenges.
- Related projects, a numbered source list, and a description of what each source supports.
- A reviewed free-use starting point with pinned source and license evidence, scope, and applicable obligations.

The interface provides section links, citations beside historical/context sections, source annotations, and license text. Starting a project from an idea prefills its first milestone as the proposed goal. The existing monochrome visual identity is retained.

## Free-to-build scope

The checked software releases or building blocks permit use, modification, commercial use, and redistribution under their stated licenses. For an independently implemented historical direction, the linked modern library is a building block; its license does not grant rights to the historical system's code, paper scans, images, trademarks, or datasets. These materials remain reference links unless separately licensed.

The corpus does not provide worldwide patent clearance or a zero-risk guarantee. It excludes identified noncommercial grants and conflicting notices. For example, the programming review rejected Subtext 10's noncommercial license and a Sketch-n-Sketch notice that conflicted with an apparently permissive license file. Boxer is scoped to a freely buildable core and a proposed free-runtime shell, not the paid-runtime GUI package.

Supplementary notices are retained and displayed where required, including Project Oberon and Unison's third-party component terms. Copyleft, notice-retention, and branding requirements remain visible. A “free to use” label never means “without conditions.”

## Source files and publication

- `research/expanded/existing.json`: detailed patches keyed by the existing 14 stable IDs.
- `research/expanded/knowledge.json`: nine knowledge/information directions.
- `research/expanded/programming.json`: nine programming/computing directions.
- `research/expanded/networks.json`: nine resilient-network/commons directions.
- Adjacent `*-notes.md` files: research methods, exclusions, rights scope, and review notes.
- `research/community-ideas.json`: the prior 12 proposal records and their grants.
- `research/catalog-rights.json`: the original nine-entry rights decisions; seven original entries remain held.

Run `node scripts/seed.mjs` to regenerate `src/data.json`. Only the explicit files above are ingested. `src/idea-details.js` validates brief completeness and reference IDs; `src/catalog-policy.js` validates reviewed reuse metadata. The build refuses incomplete briefs. Tests additionally check corpus size, distinct milestones, minimum substantive depth, source integrity, and available license-text hashes.

Catalog generation preserves existing idea IDs so local fixtures and any independently created community records can retain stable references. This describes source behavior, not retained cloud user data. The former hosted Worker and its namespaces were deleted; no user database or document archive is distributed.
