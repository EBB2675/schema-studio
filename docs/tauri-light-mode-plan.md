# Tauri Light Mode Rollout Plan

This document tracks the smallest viable path to make Schema Studio Light Mode installable as a desktop application.

## Goals

- Keep Light Mode as the first packaged target.
- Preserve the existing Python + FastAPI backend and React frontend with minimal rewrites.
- Ensure the desktop shell owns process lifecycle so no backend process remains after the app closes.
- Leave a clean extension path for heavier future modes.

## Branch Strategy

- `tauri-changes-test`
  - Base integration branch for all desktop work.
- `tauri/01-dev-env`
  - Development prerequisites, testing notes, and rollout plan.
- `tauri/02-shell`
  - Minimal Tauri shell plus backend process management for local development.
- `tauri/03-sidecar-contract`
  - Standardize how the desktop app launches a bundled backend binary.
- `tauri/04-windows-package`
  - First Windows installer path with a packaged backend.
- `tauri/05-linux-package`
  - Ubuntu packaging path.
- `tauri/06-mode-extension`
  - Generalize the launcher so heavier modes can plug into the same desktop shell.

## Recommended Architecture

For the first desktop release:

1. Keep the existing FastAPI Light Mode backend.
2. Keep the existing web frontend.
3. Add a Tauri shell that loads the frontend and starts the backend as a child process.
4. Package the backend as a separate executable or sidecar for installable builds.

This keeps the changes small and makes future mode expansion straightforward:

- Light Mode can launch one local backend.
- Heavier modes can later swap the launched command, required services, or startup profile without replacing the shell.

## Current Environment Findings

Observed in this repository on March 19, 2026:

- Python is available: `Python 3.12.7`
- Node.js is not currently installed or not on `PATH`
- Rust/Cargo is not currently installed or not on `PATH`
- `python -m venv .venv` partially created a virtual environment, but `ensurepip` failed due to filesystem permission errors while extracting wheels

That means the code changes can be prepared now, but full local validation of Tauri commands will require:

- Node.js
- Rust toolchain
- a working Python virtual environment or equivalent isolated interpreter

## Development Prerequisites

### Windows

Install:

- Python 3.11 or 3.12
- Node.js LTS
- Rust toolchain (`rustup`, `cargo`)
- WebView2 runtime if not already present
- Microsoft C++ build tools if required by Python or Rust dependencies

### Ubuntu

Install:

- Python 3.11+
- Node.js LTS
- Rust toolchain
- Tauri Linux system dependencies

## Local Development Flow

### 1. Python environment

Preferred:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
```

If `ensurepip` fails as it did in this environment, use one of these workarounds:

- use another Python installation with a working `venv`
- use Conda or Mamba
- use `virtualenv` from a global Python install

### 2. Frontend dependencies

```powershell
cd web
npm install
```

### 3. Light Mode smoke test

```powershell
schema-studio
```

Verify:

- `GET http://127.0.0.1:5179/health` returns 200
- the UI loads
- edits persist in local SQLite

### 4. Desktop smoke test

After the Tauri shell is added:

```powershell
cd web
npm run tauri:dev
```

Verify:

- the desktop window opens
- the backend process starts automatically
- closing the Tauri window also terminates the backend process
- relaunching the app does not leave the previous backend bound to port `5179`

## Packaging Strategy

### Minimal viable packaging

For installable builds, package the backend separately and let Tauri launch it as a managed sidecar.

This is the lowest-risk option because:

- Light Mode already works as a local HTTP application
- backend/frontend responsibilities stay unchanged
- installer work is isolated from the core application logic

### User experience target

End users should be able to:

1. run the installer
2. accept minimal setup decisions
3. launch the app without separately opening a browser

For the first release, the preferred experience is:

- no manual Python path entry
- Python runtime bundled with the packaged backend

If bundling Python proves too heavy for the first packaged milestone, the temporary fallback is:

- installer checks for Python
- if missing, show a clear setup requirement

## Extension Path For Heavier Modes

The desktop shell should not hardcode Light Mode forever. Instead, it should evolve toward a launcher contract:

- `light`: local backend only
- `dev`: local backend plus extra services or service checks
- future modes: custom startup profiles

The shell can stay stable if it launches a mode-specific backend command and waits for a mode-specific health endpoint.
