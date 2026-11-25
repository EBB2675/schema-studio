# Contributing

## Where to contribute
Please open issues and pull requests in the canonical upstream repository:
https://github.com/EBB2675/schema-studio

## Pull requests
- Keep PRs focused and describe the change clearly.
- Ensure tests/CI pass (if applicable).
- Follow the project’s decision process in `GOVERNANCE.md`.

## Licensing
By submitting a pull request, you agree that your contribution is provided under the MIT License (see `LICENSE`).

## Maintenance and verification

Run the four verification commands in [README.md](README.md#verification) before submitting a change. CI runs the same checks plus Chromium smoke tests against a fixture-backed production build; frontend lint allows no warnings. See the README browser smoke commands when changing navigation, persistence, worker loading, exports, or deployment. Pages reuses CI and then smoke-tests its full snapshot artifact before publishing. The default Python suite uses fixtures and excludes tests requiring real schema environments.

Keep browser UI orchestration, edit persistence, the portable Python core, and schema extraction separate (see [REPO_GUIDE.md](REPO_GUIDE.md)). Extract cohesive behavior with a clear owner rather than splitting files solely to meet a line count. Preserve edit transaction and history-generation guarantees when refactoring.

Before deleting code, check application imports, worker-bundled files, build scripts, and tests. In particular, the extractor's legacy module still has active consumers. For behavioral fixes, add a regression test at the boundary where the failure occurs. Record unresolved findings and validation limits in [REPO_AUDIT.md](REPO_AUDIT.md).
