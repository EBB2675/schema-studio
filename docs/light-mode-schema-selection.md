# Light Mode Schema Selection

This document explains how Light Mode now handles multiple schema families.

## Supported Schema Families

Light Mode currently supports two schema profiles:

- `nomad-simulations`
- `bam-masterdata`

Each profile defines:

- its fixed Light Mode branch
- its default base namespace
- its default package
- its default root section

## User Flow

When Light Mode starts:

1. Open the `Workspace` panel.
2. Pick a schema family first.
3. If the selected schema is not available locally, use the schema load/update
   action while online.
4. Once the profile is available, choose a package and root section.
5. Click `Build graph`.
6. Start editing only after the graph is loaded.

If the selected schema is unavailable and the machine is offline:

- the profile remains selectable
- package loading will not succeed
- the app should show an explicit failure instead of silently falling back

## Development Setup

### Source run

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
cd web
npm install
$env:VITE_LIGHT_MODE='true'
npm run build
cd ..
schema-studio
```

### Desktop development

```powershell
cd web
npm run tauri:dev
```

## Local Test Checklist

### Browser/source run

1. Start `schema-studio`.
2. Confirm the `Workspace` panel shows both `nomad-simulations` and
   `bam-masterdata`.
3. Select `nomad-simulations`.
4. Build a graph and confirm the default root works.
5. Switch to `bam-masterdata`.
6. Build a graph and confirm the BAM root works.

### Desktop development

1. Build the frontend:

```powershell
cd web
$env:VITE_LIGHT_MODE='true'
npm run build
cd ..
```

2. Build the backend sidecar:

```powershell
.\.venv\Scripts\python.exe scripts\build_light_mode_backend.py
```

3. Start Tauri:

```powershell
cd web
npm run tauri:dev
```

4. Verify:

- the app window opens
- schema family selection is visible before graph building
- switching between BAM and NOMAD updates the workspace
- building each graph works
- closing the app stops the backend

### Packaged desktop build

1. Rebuild the frontend and backend sidecar.
2. Build the installer:

```powershell
cd web
npm run tauri:build
```

3. Install the MSI.
4. Launch the installed app and repeat the BAM/NOMAD selection checks.

## Packaging Note

The desktop sidecar build must bundle both schema families. That is why the
PyInstaller build now collects:

- `nomad_simulations`
- `bam_masterdata`
- supporting NOMAD runtime data

## Future Work

The next product decision is still how to handle profile loading when a schema
family is not installed yet:

1. require a manual online load step
2. keep bundling both profiles in desktop builds
3. add a hybrid "bundled fallback + online refresh" flow
