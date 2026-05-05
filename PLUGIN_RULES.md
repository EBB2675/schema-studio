# Schema Plugin Rules (Draft)

This document defines the current extension contract used by Schema Studio to load and edit schema repositories.

## 1) Profile Contract (Light Mode)
A schema profile must define:
- `key`: profile identifier (e.g. `nomad`, `bam`)
- `package_import`: top-level Python import package
- `package_dist`: pip distribution name
- `default_branch`: branch used by Light Mode
- `default_remote_repo`: canonical git URL used for `schema/update`
- `default_base_namespace`: namespace root for package discovery
- `default_package`: default module for graph extraction

Current implementation lives in `api/light_mode/schema_source.py`.

## 2) Namespace-to-Repo Mapping (Dev Mode)
A schema namespace is mapped to a git repository via:
- default mapping in `api/settings.py`
- optional env override: `SCHEMA_UML_REPO_MAP`

Format:
- `SCHEMA_UML_REPO_MAP="ns.prefix=/path/or/url,other.prefix=/path/or/url"`

Matching rule:
- longest namespace prefix wins.

## 3) Extractor Entity Contract
The graph extractor (`extractor/graph_builder.py`) currently supports two shapes:

### NOMAD-like entities
Class must expose at least one of:
- `m_def`
- `quantities`
- `sub_sections`

### BAM-like entities
Class must inherit from BAM metadata base classes:
- `bam_masterdata.metadata.entities.ObjectType` / `CollectionType` / `DatasetType`
- `bam_masterdata.metadata.entities.VocabularyType`

Quantities are extracted from:
- `PropertyTypeAssignment` class attributes (object/dataset/collection types)
- `VocabularyTerm` class attributes (vocabulary types)

## 4) Editing Contract (Current)
Current CRUD in Schema Studio is graph-level and persisted as custom edits.
- persisted edits are replayed into graph responses
- this is not yet a full source-code writer/committer for schema files

## 5) Planned Pluginization (TODO)
- Externalize extractor adapters into a registry (instead of built-in NOMAD/BAM checks).
- Define adapter hooks (section detection, quantity extraction, dtype/cardinality mapping).
- Add optional code-writer plugin hooks for repository write-back and commit/push workflow.
