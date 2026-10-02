# BAM Schema Selection Plan

This note describes the next integration step after replaying the old
`bam-masterdata` branch onto the current desktop-enabled Light Mode codebase.

## Goal

Allow Light Mode users to choose which schema package they want to work with
before they start editing:

- `nomad-simulations`
- `bam-masterdata`

The same flow should work in:

- the browser-based development app
- the packaged Tauri desktop app

## Target User Experience

1. Light Mode starts without forcing one schema family into the canvas.
2. The workspace shows available schema families as explicit choices.
3. The user selects `nomad-simulations` or `bam-masterdata`.
4. Schema Studio updates the workspace package/base namespace to that profile.
5. The user can then load packages, choose a root, and build the graph.
6. Editing starts only after that schema-selection step.

When a profile is not installed locally:

- source/dev runs should report that clearly
- the app may offer a manual "load/update schema" action
- if the machine has no internet access, the load will fail cleanly and the app
  should not pretend the schema is available

For packaged desktop builds:

- both schema families should be bundled into the sidecar when possible
- users should not have to install Python packages manually

## Implementation Layers

### 1. Backend profile catalog

Add a small API contract that exposes:

- supported schema profiles
- their default package/base namespace/root
- whether the package is currently available locally
- the source/version when it is available

This keeps the frontend from hardcoding too much policy.

### 2. Workspace-first schema selection

Refactor Light Mode so schema info is resolved from the selected workspace
package/profile instead of one process-global profile only.

That allows the user to switch between BAM and NOMAD in the same running app.

### 3. Frontend selection UX

Add a dedicated schema-selection step in the workspace panel and empty state:

- show schema profile cards or buttons
- explain availability state
- apply a preset package/base namespace/root when selected
- disable editing/build flows until selection is made or restored from workspace

### 4. Desktop packaging alignment

Update the packaged backend build so both supported schema families are included
in Tauri sidecar builds.

### 5. Documentation and test flow

Document:

- local dev setup
- source-run testing
- packaged desktop testing
- offline/online expectations
- extension steps for adding another schema family later

## Risks To Watch

1. The current packaged desktop build already uses bundled schema snapshots, so
   "online only" loading is not the whole story for installers.
2. The old BAM branch changed defaults, but not the full pre-edit selection
   workflow.
3. The backend must avoid mixing BAM/NOMAD metadata when reporting schema
   version/source from the current workspace.

## Immediate Deliverables

1. Merge-safe runtime profile resolution in the Light Mode backend.
2. A schema profile picker in the web UI.
3. Desktop sidecar packaging updated to include BAM runtime assets.
4. Local testing instructions for browser and Tauri flows.
