# Desktop Mode Extension

This document describes how the Tauri desktop launcher can be extended beyond Light Mode.

## Current State

The desktop shell now separates:

- shared launcher behavior
- mode-specific launch rules

The shared behavior lives in:

- [main.rs](/D:/REPOS/schema-studio/web/src-tauri/src/main.rs)

The mode-specific behavior is represented by a small `ModeDescriptor` in that file.

Today, only `light` is implemented. The `dev` mode name is reserved as a placeholder for future heavier modes.

## What A Mode Defines

Each desktop mode should define:

- window title
- sidecar basename
- health endpoint path
- Python launch command for development fallback

That means a new mode can reuse the same:

- environment loading
- backend reuse checks
- sidecar detection
- health waiting
- shutdown/process cleanup
- Tauri window lifecycle

## How To Add Another Mode

1. Extend `DesktopMode` in [main.rs](/D:/REPOS/schema-studio/web/src-tauri/src/main.rs).
2. Add a `ModeDescriptor::for_mode(...)` entry for the new mode.
3. Define the new mode's:
   - `window_title`
   - `sidecar_basename`
   - `health_path`
   - `python_command()`
4. Make sure the backend for that mode exposes the expected health endpoint.
5. If the packaged build needs a different sidecar binary, ensure the build pipeline writes it under `web/src-tauri/binaries/` using the mode's basename.
6. Add docs and packaging/test notes before exposing the mode to users.

## Suggested Rules For Heavier Modes

If a future mode needs more than one service:

- keep the desktop shell responsible for top-level startup and shutdown
- prefer one packaged entrypoint per mode rather than many loosely-managed child processes
- make that entrypoint responsible for bringing up whatever local services the mode needs

That keeps the Tauri shell simple and avoids turning the Rust launcher into a process orchestrator for every dependency.

## Testing Checklist For A New Mode

Before shipping a new mode, verify:

- `npm run tauri:dev` launches the intended backend in that mode
- the mode answers on its configured health endpoint
- closing the app closes the backend tree
- relaunching does not leave the previous backend bound to the old port
- packaged builds prefer the sidecar over the Python fallback
- installed builds still work when the source repo is absent

## Current Recommendation

Keep Light Mode as the production desktop target until another mode can satisfy the same bar:

- installable
- self-contained
- reliable startup
- reliable shutdown
- testable without manual service wrangling
