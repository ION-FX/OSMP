#!/usr/bin/env bash
# OSMP desktop app (Linux) installer — the AppImage client.
#
#   curl -fsSL https://raw.githubusercontent.com/ION-FX/OSMP/main/scripts/install_app.sh | bash
#
# This installs the DESKTOP APP (a client). It is not the server — most
# people want the server first:  …/install.sh | bash
# (The app can also host a server on this machine instead; tick it on
# first run.)
#
# Flags (else defaults):  --dir PATH  --no-desktop  --version vX  --uninstall
set -euo pipefail

REPO="ION-FX/OSMP"
API="https://api.github.com/repos/${REPO}"
IS_ROOT=0; [[ $EUID -eq 0 ]] && IS_ROOT=1
if [[ $IS_ROOT -eq 1 ]]; then
  BIN_DIR="${OSMP_BIN_DIR:-/usr/local/bin}"
  APP_DIR="${OSMP_APP_DIR:-/usr/local/share/applications}"
  ICON_DIR="${OSMP_ICON_DIR:-/usr/share/pixmaps}"
else
  BIN_DIR="${OSMP_BIN_DIR:-$HOME/.local/bin}"
  APP_DIR="${OSMP_APP_DIR:-$HOME/.local/share/applications}"
  ICON_DIR="${OSMP_ICON_DIR:-$HOME/.local/share/icons}"
fi

usage() {
  cat <<'USAGE'
OSMP desktop app (Linux) installer

  curl -fsSL https://raw.githubusercontent.com/ION-FX/OSMP/main/scripts/install_app.sh | bash
  (with flags:  … | bash -s -- --version v0.7.7)

This installs the desktop APP — the client you actually click. If you
haven't got a server yet, install that first:
  curl -fsSL https://raw.githubusercontent.com/ION-FX/OSMP/main/scripts/install.sh | bash

Flags:
  --dir PATH     install location (default /usr/local/bin or ~/.local/bin)
  --no-desktop   skip the application-menu entry + icon
  --version vX   pin a release (default: latest)
  --uninstall    remove the app, menu entry and icon
Env: OSMP_GITHUB_TOKEN for private repos.
USAGE
}

DIR_ARG="" NO_DESKTOP=0 UNINSTALL=0 VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR_ARG="$2"; shift 2;;
    --no-desktop) NO_DESKTOP=1; shift;;
    --uninstall) UNINSTALL=1; shift;;
    --version) VERSION="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 1;;
  esac
done
[[ -n "$DIR_ARG" ]] && BIN_DIR="$DIR_ARG"

APPIMAGE="$BIN_DIR/osmp.AppImage"
LAUNCHER="$BIN_DIR/osmp"
DESKTOP_FILE="$APP_DIR/osmp.desktop"
ICON_FILE="$ICON_DIR/osmp.png"

# ── uninstall ────────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  echo "→ Removing the OSMP desktop app"
  rm -f "$APPIMAGE" "$LAUNCHER" "$DESKTOP_FILE" "$ICON_FILE"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true
  echo "OSMP desktop app removed (server installs are separate: scripts/install.sh --uninstall)."
  exit 0
fi

case "$(uname -m)" in
  x86_64) ;;
  *) echo "!! This AppImage is x86_64-only; you're on $(uname -m)." >&2; exit 1;;
esac

# ── resolve the release ──────────────────────────────────────────────
gh() {
  local p="$1"; shift
  if [[ -n "${OSMP_GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: token $OSMP_GITHUB_TOKEN" "$@" "$API$p"
  else
    curl -fsSL "$@" "$API$p"
  fi
}
if [[ -z "$VERSION" ]]; then
  echo "→ Looking up the latest OSMP release…"
  VERSION=$(gh "/releases/latest" | sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n1 || true)
  [[ -z "$VERSION" ]] && { echo "!! Could not resolve the latest release." >&2; exit 1; }
fi

# ── download ─────────────────────────────────────────────────────────
ASSET="OSMP-x86_64.AppImage"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
AUTHH=()
[[ -n "${OSMP_GITHUB_TOKEN:-}" ]] && AUTHH=(-H "Authorization: token $OSMP_GITHUB_TOKEN")
echo "→ Downloading OSMP $VERSION desktop app (~280 MB, one time)…"
mkdir -p "$BIN_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar "${AUTHH[@]}" -o "$TMP" "$URL"
chmod +x "$TMP"
mv "$TMP" "$APPIMAGE"
trap - EXIT
ln -sf "$APPIMAGE" "$LAUNCHER"   # plain `osmp` on PATH

# ── menu entry + icon ────────────────────────────────────────────────
if [[ $NO_DESKTOP -eq 0 ]]; then
  echo "→ Adding to your application menu…"
  mkdir -p "$APP_DIR" "$ICON_DIR"
  if curl -fsSL "${AUTHH[@]}" -o "$ICON_FILE" \
      "https://raw.githubusercontent.com/${REPO}/main/docs/screenshots/icon-192.png"; then
    :
  else
    rm -f "$ICON_FILE"   # icon is cosmetic — never fail the install over it
  fi
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=OSMP
Comment=Your music, your server — self-hosted player
Exec=$APPIMAGE
TryExec=$APPIMAGE
Icon=$ICON_FILE
Terminal=false
Categories=Audio;Music;Player;AudioVideo;
StartupWMClass=osmp
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true
fi

# ── FUSE check (AppImages need libfuse2 to run directly) ─────────────
FUSE_NOTE=""
if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1 \
   && [[ ! -e /dev/fuse ]]; then
  FUSE_NOTE="
  NOTE: libfuse2 isn't installed, so double-clicking the AppImage may
  fail. Either install it (Debian/Ubuntu:  sudo apt install libfuse2)
  or run the app with:  osmp --appimage-extract-and-run"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_NOTE="" ;;
  *) PATH_NOTE="
  NOTE: $BIN_DIR isn't on your PATH — use the full path or add it to PATH." ;;
esac

cat <<EOF

────────────────────────────────────────────────────────────
  OSMP $VERSION desktop app installed

  App:     $APPIMAGE
  Command: osmp   (also in your application menu)

  This is the CLIENT. Start it and either:
    • enter your server address + account  (recommended), or
    • tick "run a server on this computer" to host one here
  Updates: the app updates itself from Settings → Updates —
  no need to run this installer again.
$FUSE_NOTE$PATH_NOTE
────────────────────────────────────────────────────────────
EOF
