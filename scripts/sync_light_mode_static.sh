#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/web/dist"
DST_DIR="$ROOT_DIR/api/light_mode/static"

if [[ ! -f "$SRC_DIR/index.html" ]]; then
  echo "Missing $SRC_DIR/index.html" >&2
  echo "Build frontend first: VITE_LIGHT_MODE=true npm --prefix web run build" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
rsync -a --delete "$SRC_DIR"/ "$DST_DIR"/
echo "Synced static assets: $SRC_DIR -> $DST_DIR"
