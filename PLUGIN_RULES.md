# Schema profile contract

Profiles are defined in `api/sources/schema_source.py`. Each profile declares its key, label, package import/distribution names, canonical repository and branch, base namespace, default module/root, extraction script, LinkML prefix, editing rules, and optional capabilities (`usage`, `methods`).

Add an isolated uv project under `environments/` for the profile's schema package. Extraction runs through `extractor/runner.py` using that environment's interpreter. It must produce a document matching `extractor/contract.schema.json`. The converter in `api/sources/to_linkml/` turns that document into the LinkML snapshot consumed by the browser.

Add profile defaults to `web/src/constants/defaults.ts` and include the environment in the Pages workflow. `scripts/build_snapshots.py` includes profiles with a converter automatically. Add fixture-based extraction/conversion tests before publishing a profile.

Browser edits use the operations in `api/sources/edits.py` and are persisted locally by `web/src/static/editStore.ts`. Edits modify the browser's schema representation and exported files; they do not write to the upstream schema repository.
