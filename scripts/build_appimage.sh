#!/usr/bin/env bash
# Build the OSMP Linux AppImage:
#   PyInstaller onedir (server + webui + ffmpeg + Qt WebEngine) → AppDir → AppImage
# Usage: bash scripts/build_appimage.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${OSMP_TOOLS:-$HOME/tools}"
mkdir -p "$TOOLS"

DIST="$ROOT/dist"
BUILD="$ROOT/build"
APPDIR="$ROOT/desktop/AppDir"
OUT="$ROOT/dist"

# ── tooling ──────────────────────────────────────────────────────────
# An AppImage is literally: [runtime binary][squashfs of the AppDir].
# appimagetool only validates + concatenates (and needs the `file` util),
# so we do the two steps ourselves with mksquashfs + the official runtime.
# NOTE: the official runtime links libfuse2. Distros without it (Ubuntu
# 23.04+) can still run the AppImage via --appimage-extract-and-run; this
# is documented in the README.
RUNTIME="$TOOLS/runtime-x86_64"
if [ ! -f "$RUNTIME" ]; then
  echo "→ downloading AppImage runtime"
  curl -sL --retry 3 -o "$RUNTIME" \
    https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64
  chmod +x "$RUNTIME"
fi
head -c 4 "$RUNTIME" | grep -q ELF || { echo "runtime download is not an ELF"; exit 1; }

# ── PyInstaller bundle ───────────────────────────────────────────────
if [ -x "$DIST/osmp_desktop/osmp_desktop" ] && [ -n "${SKIP_PYINSTALLER:-}" ]; then
  echo "→ reusing existing PyInstaller bundle (SKIP_PYINSTALLER set)"
else
echo "→ PyInstaller onedir bundle (this takes a few minutes)"
cd "$ROOT"
rm -rf "$DIST" "$BUILD"
python3 -m PyInstaller --noconfirm --clean --onedir \
  --name osmp_desktop \
  --paths "$ROOT/server" \
  --add-data "$ROOT/webui:webui" \
  --add-data "$TOOLS/ffmpeg/bin/ffmpeg:vendor/ffmpeg" \
  --collect-submodules yt_dlp \
  --collect-submodules mutagen \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan --hidden-import uvicorn.lifespan.on \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.protocols.websockets.wsproto_impl \
  --hidden-import websockets.legacy.server \
  --hidden-import platformdirs \
  --collect-submodules pkg_resources \
  desktop/osmp_desktop.py 2>&1 | grep -E "ERROR|CRITICAL" || true
fi

[ -x "$DIST/osmp_desktop/osmp_desktop" ] || { echo "PyInstaller output missing"; exit 1; }

# ── AppDir assembly ──────────────────────────────────────────────────
echo "→ assembling AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp -r "$DIST/osmp_desktop" "$APPDIR/usr/lib/osmp-desktop"
mkdir -p "$APPDIR/usr/bin"
ln -sf ../../AppRun "$APPDIR/usr/bin/osmp-desktop"
cp "$ROOT/webui/icons/icon-512.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/osmp.png"
cp "$ROOT/webui/icons/icon-512.png" "$APPDIR/osmp.png"
cp "$APPDIR/osmp.png" "$APPDIR/.DirIcon"

cat > "$APPDIR/osmp-desktop.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=OSMP
Comment=Open-Source Music Player — self-hosted streaming
Exec=osmp-desktop
Icon=osmp
Categories=AudioVideo;Audio;Player;
Terminal=false
DESKTOP

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
export LD_LIBRARY_PATH="$HERE/usr/lib:$LD_LIBRARY_PATH"
export QTWEBENGINE_DISABLE_SANDBOX=1
exec "$HERE/usr/lib/osmp-desktop/osmp_desktop" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# ── package ──────────────────────────────────────────────────────────
echo "→ packaging AppImage (mksquashfs + runtime)"
mkdir -p "$OUT"
rm -f "$OUT/OSMP-x86_64.AppImage" "$OUT/osmp.squashfs"
mksquashfs "$APPDIR" "$OUT/osmp.squashfs" -noappend -comp xz \
  -Xbcj x86 -quiet
cat "$RUNTIME" "$OUT/osmp.squashfs" > "$OUT/OSMP-x86_64.AppImage"
rm -f "$OUT/osmp.squashfs"
chmod +x "$OUT/OSMP-x86_64.AppImage"
ls -la "$OUT/OSMP-x86_64.AppImage"

# ── headless smoke test ──────────────────────────────────────────────
# This VM has no libfuse2, so exercise the extract-and-run path (identical
# AppRun; on FUSE-capable machines the plain invocation works).
echo "→ smoke test (offscreen Qt + embedded server)"
rm -rf /tmp/osmp-appimage-smoke
QT_QPA_PLATFORM=offscreen timeout 150 "$OUT/OSMP-x86_64.AppImage" \
  --appimage-extract-and-run --smoke --data /tmp/osmp-appimage-smoke
echo "✓ AppImage smoke test passed"
