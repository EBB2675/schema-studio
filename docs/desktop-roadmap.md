# Desktop Roadmap

This note summarizes the current desktop design, why it is maintainable, and
what should come next.

## Current Design

Schema Studio desktop currently uses:

- a Tauri shell for the native window and installer packaging
- a packaged Python backend sidecar for Light Mode
- the existing local HTTP backend/frontend split

That design has worked well so far because it keeps the desktop layer thin:

- Tauri owns startup and shutdown
- the backend stays responsible for application behavior
- packaged builds remain self-contained for end users

## Maintenance Assessment

The current design is good enough for ongoing maintenance because:

- the desktop launcher is now organized around a small mode contract
- the Windows and Linux packaging paths share the same sidecar model
- the packaged backend is isolated from user Python installations
- shutdown behavior is explicit instead of relying on implicit shell cleanup

The main maintenance risk is documentation drift between:

- repo README
- desktop usage/build notes
- future mode-extension notes

When desktop behavior changes, those docs should be updated together.

## Near-Term Priorities

1. Keep Light Mode stable across Windows and Linux packaging flows.
2. Add CI coverage for desktop bundle production where practical.
3. Keep the packaged runtime self-contained and avoid introducing manual setup for users.

## Medium-Term Priorities

1. Align desktop versioning with the main package version if release cadence becomes shared.
2. Add release automation for Windows and Linux desktop artifacts.
3. Improve packaged update strategy for the bundled schema snapshot.

## Future Modes

If heavier modes are introduced later, prefer:

- one packaged backend entrypoint per mode
- one health endpoint per mode
- one launcher descriptor entry per mode

Avoid making the Tauri shell directly orchestrate many unrelated helper
services unless there is a strong reason to do so.
