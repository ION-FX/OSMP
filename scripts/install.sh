#!/usr/bin/env bash
# OSMP server installer — "download and it just works".
#
#   curl -fsSL https://raw.githubusercontent.com/ION-FX/OSMP/main/scripts/install.sh | bash
#
# For a private repo, hand curl your PAT:
#   curl -fsSL -H "Authorization: token $OSMP_GITHUB_TOKEN" ... | bash
#
# Flags (else interactive prompts):  --host IP --port N --dir PATH
#   --no-systemd   don't install a service, just print the run command
#   --uninstall    remove the service + files
#   --version vX   pin a release (default: latest)
set -euo pipefail

OSMP_SERVICE="${OSMP_SERVICE:-osmp}"
REPO="ION-FX/OSMP"
API="https://api.github.com/repos/${REPO}"
IS_ROOT=0; [[ $EUID -eq 0 ]] && IS_ROOT=1
if [[ $IS_ROOT -eq 1 ]]; then
  OSMP_HOME="${OSMP_HOME:-/opt/osmp}"
  OSMP_DATA="${OSMP_DATA:-/var/lib/osmp}"
else
  # rootless mode: everything under $HOME
  OSMP_HOME="${OSMP_HOME:-$HOME/.local/share/osmp}"
  OSMP_DATA="${OSMP_DATA:-$HOME/.local/share/osmp/data}"
fi

# ── flags ────────────────────────────────────────────────────────────
HOST_ARG="" PORT_ARG="" DIR_ARG="" NO_SYSTEMD=0 UNINSTALL=0 VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST_ARG="$2"; shift 2;;
    --port) PORT_ARG="$2"; shift 2;;
    --dir)  DIR_ARG="$2"; shift 2;;
    --data) OSMP_DATA="$2"; shift 2;;
    --no-systemd) NO_SYSTEMD=1; shift;;
    --uninstall) UNINSTALL=1; shift;;
    --version) VERSION="$2"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

if [[ $IS_ROOT -eq 0 && -t 0 && -z "$HOST_ARG" ]]; then
  echo "→ No root: installing into your home directory (user-level service where possible)."
fi

# ── uninstall ────────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  echo "→ Removing OSMP"
  systemctl stop "$OSMP_SERVICE" 2>/dev/null || true
  systemctl disable "$OSMP_SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/${OSMP_SERVICE}.service"
  systemctl --user stop "$OSMP_SERVICE" 2>/dev/null || true
  systemctl --user disable "$OSMP_SERVICE" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/${OSMP_SERVICE}.service"
  systemctl daemon-reload 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
  rm -rf "$OSMP_HOME"
  echo "Kept your library/data at $OSMP_DATA — delete it manually if you're sure."
  echo "OSMP removed."
  exit 0
fi

# ── GitHub fetch helper (private repos need a token) ─────────────────
gh() {  # gh <path> [curl args...]
  local path="$1"; shift
  if [[ -n "${OSMP_GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: token $OSMP_GITHUB_TOKEN" "$@" "$API$path"
  else
    curl -fsSL "$@" "$API$path"
  fi
}

# ── resolve the release to install ───────────────────────────────────
if [[ -z "$VERSION" ]]; then
  echo "→ Looking up the latest OSMP release…"
  VERSION=$(gh "/releases/latest" | grep -oP '"tag_name":\s*"\K[^"]+' || true)
  if [[ -z "$VERSION" ]]; then
    echo "!! Could not resolve the latest release (private repo? set OSMP_GITHUB_TOKEN)." >&2
    exit 1
  fi
fi
echo "→ Installing OSMP $VERSION"

ASSET="osmp-server-${VERSION#v}.tar.gz"

# ── download + unpack ────────────────────────────────────────────────
echo "→ Downloading $ASSET"
TMP=$(mktemp -d)
AUTHH=()
[[ -n "${OSMP_GITHUB_TOKEN:-}" ]] && AUTHH=(-H "Authorization: token $OSMP_GITHUB_TOKEN")
# private repos: resolve the asset id, then fetch via the API's octet-stream
# endpoint — the browser_download_url redirects to S3, which rejects requests
# that still carry the Authorization header, so strip it after the redirect
ASSET_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
if [[ -n "${OSMP_GITHUB_TOKEN:-}" ]]; then
  ASSET_ID=$(gh "/releases/tags/$VERSION" | python3 -c "
import json, sys
for a in json.load(sys.stdin).get('assets', []):
    if a['name'] == '$ASSET':
        print(a['id']); break" 2>/dev/null || true)
  if [[ -n "$ASSET_ID" ]]; then
    LOC=$(curl -s -H "Authorization: token $OSMP_GITHUB_TOKEN" \
      -H "Accept: application/octet-stream" \
      -o /dev/null -w '%{redirect_url}' \
      "https://api.github.com/repos/${REPO}/releases/assets/$ASSET_ID")
    if [[ -n "$LOC" ]]; then
      ASSET_URL="$LOC"; AUTHH=()
    else
      ASSET_URL="https://api.github.com/repos/${REPO}/releases/assets/$ASSET_ID"
    fi
  fi
fi
if ! curl -fsSL "${AUTHH[@]}" -o "$TMP/$ASSET" "$ASSET_URL"; then
  echo "!! Download failed (private repo? set OSMP_GITHUB_TOKEN)" >&2
  exit 1
fi
if [[ $IS_ROOT -eq 1 ]] && command -v apt-get >/dev/null 2>&1; then
  echo "→ Checking system packages (python3-venv, ffmpeg, curl)…"
  NEEDS=()
  python3 -c 'import venv' 2>/dev/null || NEEDS+=(python3-venv python3.12-venv python3.11-venv)
  command -v ffmpeg >/dev/null 2>&1 || NEEDS+=(ffmpeg)
  command -v curl   >/dev/null 2>&1 || NEEDS+=(curl)
  if [[ ${#NEEDS[@]} -gt 0 ]]; then
    (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEEDS[@]}") \
      || echo "  (couldn't apt-install ${NEEDS[*]} — continuing, may still work)"
  fi
fi
command -v python3 >/dev/null 2>&1 || { echo "!! python3 required" >&2; exit 1; }

# ── prompts (skipped when flags given / non-interactive) ─────────────
if [[ -t 0 ]]; then
  if [[ -z "$HOST_ARG" ]]; then
    DEF_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    read -r -p "Bind address [${DEF_IP:-0.0.0.0}]: " HOST_ARG || true
    HOST_ARG=${HOST_ARG:-${DEF_IP:-0.0.0.0}}
  fi
  if [[ -z "$PORT_ARG" ]]; then
    read -r -p "Port [8543]: " PORT_ARG || true
    PORT_ARG=${PORT_ARG:-8543}
  fi
fi
HOST_ARG=${HOST_ARG:-0.0.0.0}
PORT_ARG=${PORT_ARG:-8543}
[[ -n "$DIR_ARG" ]] && OSMP_HOME="$DIR_ARG"

# ── download + unpack ────────────────────────────────────────────────
mkdir -p "$OSMP_HOME" "$OSMP_DATA"
tar -xzf "$TMP/$ASSET" -C "$OSMP_HOME" --strip-components=1
rm -rf "$TMP"

# ── venv + deps (falls back to --user pip on minimal boxes) ──────────
echo "→ Installing Python dependencies…"
PYBIN=""
if python3 -m venv "$OSMP_HOME/server/venv" 2>/dev/null; then
  PYBIN="$OSMP_HOME/server/venv/bin/python"
  "$PYBIN" -m pip install -q --upgrade pip 2>/dev/null || true
  "$PYBIN" -m pip install -q -r "$OSMP_HOME/server/requirements.txt"
else
  echo "  (venv unavailable — installing with pip --user)"
  PYBIN="python3"
  python3 -m pip install -q --user --break-system-packages -r "$OSMP_HOME/server/requirements.txt"
fi

# ── service (system unit as root, user unit otherwise) ───────────────
# "degraded" is the normal state on real servers (one failed unit somewhere);
# refusing it would silently skip systemd entirely
systemd_ok() { command -v systemctl >/dev/null 2>&1 \
  && systemctl is-system-running 2>/dev/null | grep -qE '^(running|degraded)'; }

RUN_USER="${SUDO_USER:-root}"
if [[ $IS_ROOT -eq 1 && $NO_SYSTEMD -eq 0 ]] && systemd_ok; then
  UNIT="/etc/systemd/system/${OSMP_SERVICE}.service"
  UNIT_KIND="system service"
  sed -e "s|__OSMP_USER__|$RUN_USER|g" \
      -e "s|__OSMP_HOME__|$OSMP_HOME|g" \
      -e "s|__OSMP_PY__|$PYBIN|g" \
      -e "s|__OSMP_DATA__|$OSMP_DATA|g" \
      -e "s|__OSMP_HOST__|$HOST_ARG|g" \
      -e "s|__OSMP_PORT__|$PORT_ARG|g" \
      "$OSMP_HOME/scripts/osmp-server.service" > "$UNIT"
  chown -R "$RUN_USER": "$OSMP_DATA" "$OSMP_HOME" 2>/dev/null || chown -R "$RUN_USER" "$OSMP_DATA" "$OSMP_HOME"
  systemctl daemon-reload
  systemctl enable --now "$OSMP_SERVICE" >/dev/null 2>&1 || systemctl enable --now "$OSMP_SERVICE"
  STATUS="service:  systemctl status $OSMP_SERVICE"
  RUN_CMD=""
elif [[ $NO_SYSTEMD -eq 0 ]] && systemctl --user is-system-running 2>/dev/null | grep -qE '^(running|degraded)'; then
  mkdir -p "$HOME/.config/systemd/user"
  UNIT="$HOME/.config/systemd/user/${OSMP_SERVICE}.service"
  UNIT_KIND="user service"
  sed -e "s|__OSMP_USER__|$USER|g" \
      -e "s|__OSMP_HOME__|$OSMP_HOME|g" \
      -e "s|__OSMP_PY__|$PYBIN|g" \
      -e "s|__OSMP_DATA__|$OSMP_DATA|g" \
      -e "s|__OSMP_HOST__|$HOST_ARG|g" \
      -e "s|__OSMP_PORT__|$PORT_ARG|g" \
      -e "s|^User=.*||; s|^Group=.*||; s|ProtectHome=read-only|ProtectHome=no|; s|^ReadWritePaths=.*||; s|WantedBy=multi-user.target|WantedBy=default.target|" \
      "$OSMP_HOME/scripts/osmp-server.service" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now "$OSMP_SERVICE" || true
  STATUS="service:  systemctl --user status $OSMP_SERVICE"
  RUN_CMD=""
  if loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=no'; then
    echo "  (hint: 'sudo loginctl enable-linger $USER' keeps it running after logout)"
  fi
else
  STATUS="(no systemd — run it yourself)"
  RUN_CMD="  $OSMP_HOME/server/venv/bin/python $OSMP_HOME/server/run.py --host $HOST_ARG --port $PORT_ARG --data $OSMP_DATA"
fi

sleep 2
# probe the address we actually bound to — 0.0.0.0 isn't curlable, and a
# specific LAN IP refuses loopback probes, which made healthy installs
# report "not responding yet"
HEALTH_HOST="127.0.0.1"
[[ "$HOST_ARG" != "0.0.0.0" && "$HOST_ARG" != "::" ]] && HEALTH_HOST="$HOST_ARG"
if curl -fsS "http://$HEALTH_HOST:$PORT_ARG/api/health" >/dev/null 2>&1; then
  HEALTH="✓ server is up"
else
  HEALTH="(not responding yet — check journalctl -u $OSMP_SERVICE if you installed the service)"
fi

cat <<EOF

────────────────────────────────────────────────────────────
  OSMP $VERSION installed

  Address:    http://$HOST_ARG:$PORT_ARG
  Files:      $OSMP_HOME
  Library:    $OSMP_DATA
  $STATUS
  Status:     $HEALTH

  NEXT STEPS
  1. Open http://$HOST_ARG:$PORT_ARG in your browser
  2. Create the admin account (first visit only)
  3. Settings → Accounts to invite listeners
     (locked out later?  run.py --reset-password <user> on this box)
  4. Install the Android APK / Linux AppImage and point them here
$RUN_CMD
────────────────────────────────────────────────────────────
EOF
