# Schema Profiles

A schema profile is one schema family Schema Studio can show. The profiles are
defined in `api/schema_profiles.py`:

| Profile | Package | Tracked branch | Default module | Default root |
|---|---|---|---|---|
| `nomad-simulations` | `nomad-simulations` | `develop` | `nomad_simulations.schema_packages.model_method` | `ModelMethod` |
| `nomad-measurements` | `nomad-measurements` | `main` | `nomad_measurements.xrd.schema` | `ELNXRayDiffraction` |
| `bam-masterdata` | `bam-masterdata` | `main` | `bam_masterdata.datamodel.object_types` | `SearchQuery` |

Each profile also defines its base namespace, how its modules are found
(schema entry points and/or walking the namespace), its LinkML prefix and
converter script, what it offers besides the schema (`usage`, `methods`), and
its edit rules (`api/sources/edits.py`).

## Environments

Each profile has its own uv project under `environments/<profile>/`, which
installs only that schema package from its tracked branch. The app never
installs or imports a schema package: it reads a schema by running a script
from `extractor/scripts/` with the environment's Python.

```bash
uv sync --project environments/<profile>                                  # create
uv lock --project environments/<profile> --upgrade-package <package>    # move to the latest commit
uv sync --project environments/<profile>
```

An environment must be installed from the profile's repository and branch;
local checkouts and other branches are refused.

## Where profiles are used

- **Static site:** `scripts/build_snapshots.py` builds the snapshot files of
  every profile whose environment is set up. The site lists those profiles as
  schema family buttons; hovering over one shows the commit it was built from.
- **Dev Mode:** the server finds the profile of a package by its name and reads
  the schema from that profile's environment, or from a branch worktree. The
  sidebar shows the three families as buttons.

## Checking the selection

1. Open the `Workspace` panel.
2. Pick a schema family; the package and root fields switch to its defaults.
3. Click `Build graph` and confirm the default root works.
4. Switch to another family and repeat.
