#!/bin/sh
set -e

schema_repo_path="${SCHEMA_UML_REPO:-/schema-repo}"

# Allow git operations on the mounted schema repo even if ownership differs inside the container.
git config --global --add safe.directory "${schema_repo_path}" >/dev/null 2>&1 || true
git config --global --add safe.directory "${schema_repo_path}/.git" >/dev/null 2>&1 || true

# The schema package and its dependencies live in /app/environments/<profile>/,
# built into the image. Nothing is installed into the app's Python here, and the
# mounted schema repo is not put on PYTHONPATH.

exec "$@"
