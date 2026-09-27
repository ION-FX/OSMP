#!/usr/bin/env bash
# Build the server-only tarball attached to each GitHub release:
#   osmp-server-<version>.tar.gz   (server/, webui/, scripts/osmp-server.service)
# Usage: scripts/package_server.sh [output-dir]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import sys; sys.path.insert(0, 'server'); from osmp import __version__; print(__version__)")
OUT="${1:-dist}"
mkdir -p "$OUT"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/osmp"
cp -r server "$STAGE/osmp/server"
cp -r webui "$STAGE/osmp/webui"
mkdir -p "$STAGE/osmp/scripts"
cp scripts/osmp-server.service "$STAGE/osmp/scripts/"
rm -rf "$STAGE/osmp/server/venv" "$STAGE/osmp/server/__pycache__"
find "$STAGE/osmp/server" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

TARBALL="$OUT/osmp-server-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" osmp
echo "→ $TARBALL ($(du -h "$TARBALL" | cut -f1))"
