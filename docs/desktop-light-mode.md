# Desktop Light Mode

This document covers the current Tauri desktop path for Schema Studio Light Mode.

## User Experience

The packaged desktop app is designed so end users do not need to install Python, create a virtual environment, or run `pip install`.

The Windows installer currently ships:
- the Tauri desktop shell
- a bundled Python backend executable
- a bundled Light Mode frontend build
- a bundled `nomad_simulations` schema package snapshot

Current limitation:
- packaged builds do not self-update the bundled schema yet
- to get a newer schema, install a newer desktop release

## Using The Installed App

1. Install the Windows package.
2. Launch `Schema Studio Light`.
3. Choose a package such as `nomad_simulations.schema_packages.model_method`.
4. Choose a root section if you want to narrow the graph.
5. Click `Build graph`.

Light Mode stores local state in SQLite. Your edits persist between launches.

## Uninstall

On Windows, uninstall the app using one of these normal system paths:
- `Settings -> Apps -> Installed apps -> Schema Studio Light -> Uninstall`
- `Control Panel -> Programs and Features -> Schema Studio Light -> Uninstall`

Uninstalling the MSI removes the app binaries. Local user data may remain.

## Local Data

By default, Light Mode stores local data under the platform config directory used by `platformdirs`.

On Windows that is typically under:

```text
%APPDATA%\schema_studio_light\schema_studio_light\
```

The main file is:

```text
light_mode.sqlite3
```

If you want a fully clean uninstall, remove that folder after uninstalling the app.

## Development Workflow

### Backend + frontend from source

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
cd web
npm install
$env:VITE_LIGHT_MODE='true'
npm run build
cd ..
```

### Desktop development

The Tauri launcher reads the repo-root `.env`.

For development, it is fine to set:

```env
SCHEMA_STUDIO_DESKTOP_MODE=light
SCHEMA_STUDIO_DESKTOP_PYTHON=<repo>\.venv\Scripts\python.exe
SCHEMA_STUDIO_DIST_DIR=<repo>\web\dist
SCHEMA_STUDIO_OPEN_BROWSER=0
```

Then run:

```powershell
cd web
npm run tauri:dev
```

### Desktop packaging

1. Build the frontend:

```powershell
cd web
$env:VITE_LIGHT_MODE='true'
npm run build
cd ..
```

2. Build the bundled backend executable:

```powershell
.\.venv\Scripts\python.exe scripts\build_light_mode_backend.py
```

3. Build the Windows installer:

```powershell
cd web
npm run tauri:build
```

Expected MSI output:

```text
web\src-tauri\target\release\bundle\msi\
```

### Linux packaging

Build Linux installers on a Linux machine or Linux CI runner.

On Ubuntu, install the Tauri/Linux prerequisites first, then run:

```bash
cd web
VITE_LIGHT_MODE=true npm run build
cd ..
python scripts/build_light_mode_backend.py
cd web
npm run tauri:build:linux
```

Expected default Linux output:

```text
web/src-tauri/target/release/bundle/deb/
```

If you also want a portable AppImage build:

```bash
cd web
npm run tauri:build:linux:portable
```

## Test Checklist

### Development

- `npm run tauri:dev` opens the desktop window
- no extra browser tab opens
- closing the app removes the backend listener on `127.0.0.1:5179`
- `Build graph` succeeds for the default package
- the launcher reports `light` behavior through the shared mode contract without changing the working Light Mode UX

### Packaged Windows build

- install the MSI on a machine without using the repo checkout
- launching the app opens one app window and no console window
- `Build graph` works immediately
- local edits survive closing and reopening the app
- uninstall works from Windows Settings

## Extending Beyond Light Mode

The desktop shell is now structured so shared launcher behavior is separate from mode-specific rules.

See:

- [desktop-mode-extension.md](./desktop-mode-extension.md)

Use that guide before adding a heavier mode so startup, shutdown, and sidecar packaging stay consistent.

## Future Direction

The current desktop target is intentionally conservative:

- ship Light Mode first
- keep the backend as a local HTTP service
- keep packaging self-contained for end users

Future work should build on the shared launcher contract rather than adding
special-case process logic per mode.
