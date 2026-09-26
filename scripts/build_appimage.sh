#!/usr/bin/env bash
# Build the OSMP Linux AppImage:
#   PyInstaller onedir (server + webui + ffmpeg + Qt WebEngine) → AppDir → AppImage
# Usage: bash scripts/build_appimage.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${OSMP_TOOLS:-$HOME/tools}"
mkdir -p "$TOOLS"

APPIMAGETOOL="$TOOLS/appimagetool-x86_64.AppImage"
DIST="$ROOT/dist"
BUILD="$ROOT/build"
APPDIR="$ROOT/desktop/AppDir"
OUT="$ROOT/dist"

# ── tooling ──────────────────────────────────────────────────────────
if [ ! -f "$APPIMAGETOOL" ]; then
  echo "→ downloading appimagetool"
  curl -sL --retry 3 -o "$APPIMAGETOOL" \
    https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$APPIMAGETOOL"
fi

# appimagetool itself ships a libfuse2 runtime that modern distros lack:
# extract it once and run the unpacked binary (no FUSE needed).
if [ ! -x "$TOOLS/squashfs-root/AppRun" ]; then
  echo "→ extracting appimagetool (FUSE-free invocation)"
  ( cd "$TOOLS" && ./appimagetool-x86_64.AppImage --appimage-extract >/dev/null 2>&1 )
fi

# embed the fuse3 runtime into OUR AppImage so it runs on current
# Ubuntu/Fedora (which ship libfuse3, not libfuse2) out of the box.
RUNTIME_FUSE3="$TOOLS/runtime-fuse3-x86_64"
if [ ! -f "$RUNTIME_FUSE3" ]; then
  echo "→ downloading fuse3 runtime"
  curl -sL --retry 3 -o "$RUNTIME_FUSE3" \
    https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-fuse3-x86_64
  chmod +x "$RUNTIME_FUSE3"
fi

# ── PyInstaller bundle ───────────────────────────────────────────────
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
  desktop/osmp_desktop.py 2>&1 | grep -E "ERROR|CRITICAL" || true

[ -x "$DIST/osmp_desktop/osmp_desktop" ] || { echo "PyInstaller output missing"; exit 1; }

# ── AppDir assembly ──────────────────────────────────────────────────
echo "→ assembling AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp -r "$DIST/osmp_desktop" "$APPDIR/usr/lib/osmp-desktop"
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
exec "$HERE/usr/lib/osmp-desktop/osmp-desktop" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# ── package ──────────────────────────────────────────────────────────
echo "→ packaging AppImage"
mkdir -p "$OUT"
rm -f "$OUT/OSMP-x86_64.AppImage"
"$TOOLS/squashfs-root/AppRun" "$APPDIR" "$OUT/OSMP-x86_64.AppImage" \
  --runtime-file "$RUNTIME_FUSE3" 2>&1 | tail -3
chmod +x "$OUT/OSMP-x86_64.AppImage"
ls -la "$OUT/OSMP-x86_64.AppImage"

# ── headless smoke test ──────────────────────────────────────────────
echo "→ smoke test (offscreen Qt + embedded server)"
rm -rf /tmp/osmp-appimage-smoke
QT_QPA_PLATFORM=offscreen timeout 150 "$OUT/OSMP-x86_64.AppImage" --smoke --data /tmp/osmp-appimage-smoke
echo "✓ AppImage smoke test passed"
