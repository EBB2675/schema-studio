# Governance

## Purpose
Schema Studio is an open-source project developed collaboratively, providing a stable, community-oriented tool for exploring and editing data-model schemas. Its long-term goal is to enable interoperability by offering a shared platform for data models in materials science.

## Guiding principles
- Open science by default: permissive licensing and reproducible, reviewable changes
- Shared maintainership with equal decision-making authority
- Open development and transparent decisions
- Stable releases and predictable change management

## Repositories and project "upstream"

### Canonical upstream
The canonical upstream is the repository where:
- issues are tracked
- pull requests are opened and reviewed
- releases are created and tagged
- the roadmap is maintained

This repository is the upstream unless explicitly changed by the maintainers.

- Canonical upstream: [https://github.com/EBB2675/schema-studio]

### Downstream mirrors
Institutional or organizational repositories may host downstream mirrors for visibility, archival, or operational reasons (for example, CI, deployment, or sustainability requirements).

Downstream mirrors are not considered the canonical development location unless the maintainers explicitly designate them as such.

Downstream mirrors should:
- clearly link back to the canonical upstream
- normally disable issues and pull requests, or clearly redirect them to the canonical upstream
- avoid accepting direct feature development unless explicitly coordinated with upstream
- prefer tracking tagged releases or a protected `stable` branch

If a downstream mirror accepts pull requests, changes should be limited to operational needs (for example packaging, deployment, documentation). The mirror should also keep in sync with upstream to avoid long-term divergence.

## Roles

### Maintainers
Maintainers are responsible for:
- reviewing and merging pull requests
- triaging issues
- managing releases
- ensuring licensing and attribution remain correct
- keeping governance documents up to date

The current maintainers are listed in `MAINTAINERS.md`.

New maintainers are added with approval from two existing maintainers.

### Contributors
Anyone can contribute via pull requests. Contributors are expected to follow the contribution process described in `CONTRIBUTING.md`.

## Decision-making

### Routine changes
Bug fixes, refactors, documentation updates, and small improvements can be merged with approval from one maintainer.

### Significant changes
Any of the following require approval from two maintainers:
- API or data model changes
- architectural changes
- new major dependencies
- changes that affect licensing, copyright, or distribution
- changes that impact backward compatibility

## Releases
- Releases are created from upstream and tagged using semantic versioning (for example, `v0.5.0`).
- Release notes should summarize user-facing changes and any breaking changes.
- Downstream mirrors may sync from tags or the protected `stable` branch.

## Changes to governance
This file can be changed only with approval from two maintainers.

## Licensing
Schema Studio is distributed under the MIT License (see `LICENSE`). Contributions are accepted under the same terms.