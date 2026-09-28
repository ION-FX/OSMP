# Self-hosting OSMP

A practical guide to running OSMP on your own box: install, accounts,
backups, offline behavior, clients, and the things that break at 2 AM.
The README covers the 90-second version; this is the rest.

## 1. Requirements

| What | Why | Notes |
|---|---|---|
| Linux box (x86_64/arm) | runs the server | any distro with Python 3.10+ |
| Python 3.10+ | FastAPI server, yt-dlp | 3.11+ recommended |
| ffmpeg | transcodes downloads to m4a/opus | static binary auto-bundled in release tarball |
| ~200 MB RAM idle | server + SQLite | grows with concurrent streams |
| Outbound HTTPS | YouTube + LRCLIB (lyrics) | both proxied server-side |

No node, no npm, no build step anywhere in the stack. Clients are the
browser (PWA), the Linux AppImage, and the Android APK — all optional.

## 2. Install

Root with systemd (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/ION-FX/OSMP/main/scripts/install.sh | sudo bash
```

The installer asks for bind IP and port (defaults: LAN IP, `8543`), pulls
the latest release tarball from GitHub, creates a venv under
`/opt/osmp/server/venv`, installs `osmp.service`, and starts it.

Without root (user-level systemd, `~/.local/share/osmp`):

```bash
curl -fsSL <installer-url> | bash   # detects the missing sudo and adapts
```

Useful installer flags: `--host 0.0.0.0 --port 8790 --no-systemd
--uninstall`. Private repo? `export OSMP_GITHUB_TOKEN=github_pat_…` first.

From source (git checkout):

```bash
cd server
python3 -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python run.py --host 0.0.0.0 --port 8543
```

Verify: `curl http://127.0.0.1:8543/api/health` → `{"ok": true, …}`.

### Where things live

| Path (rootless in `~/.local/share/osmp`) | Contents |
|---|---|
| `/opt/osmp/server/` | code + venv |
| `/var/lib/osmp/` | `osmp.db`, `downloads/`, logs |
| `osmp.service` | system unit (or `~/.config/systemd/user/`) |

## 3. First-run setup

1. Open `http://<server-ip>:<port>` — you'll get a one-time screen to
   create the **admin** account (username + password, optional server name).
   After that the server only accepts logins.
2. Settings → Accounts to add **listeners**. Listeners stream, build
   playlists, import, download and get their own history/stats; they cannot
   manage users, settings, updates or backups.
3. Point clients at the same address.

Lost the admin password? The server shell can always recover it
(works while the server is running — SQLite WAL allows both):

```bash
python3 server/run.py --list-users
python3 server/run.py --reset-password admin
```

With systemd installs, prefix the venv python:
`/opt/osmp/server/venv/bin/python /opt/osmp/server/run.py --reset-password admin`.

## 4. Data, backups, migration

- **Everything user-visible is one SQLite file** (`osmp.db`) plus the
  `downloads/` folder. Copy both and you've cloned the instance.
- **Library backup** (Settings → Backup & restore, admin): exports
  playlists, track metadata and safe settings as a JSON file. Import on any
  instance merges by playlist name — nothing is deleted. Accounts, sessions,
  LLM keys and GitHub tokens are deliberately excluded.
- Recommended cadence: nightly copy of the data dir:

```bash
cp -a /var/lib/osmp /backup/osmp-$(date +%F)
```

- **Migrating servers**: install fresh on the new box, create the admin,
  import the backup JSON, then rsync `downloads/` if you want the offline
  library too.

## 5. Networking

- Bind to `0.0.0.0` for LAN access; the installer defaults to your LAN IP.
- **HTTPS**: put your favorite reverse proxy (Caddy, nginx, Traefik) in
  front. This also unlocks the installable PWA on non-localhost origins.
- **Remote access**: a VPN like Tailscale/WireGuard is the simplest safe
  option — the server has no built-in rate limiting, so don't naked-expose
  it to the internet.
- Ports: one TCP port for everything (UI + API + audio). Range requests are
  proxied server-side, so seeking works through plain HTTP.

## 6. Offline behavior (per client)

| Client | Mechanism | What works offline |
|---|---|---|
| Browser / AppImage | service worker + Cache API (`Save to this device` on any ⋮ menu) | saved audio, the app shell, queued sync |
| Android | native downloads via `offline.osmp.local` interception | any downloaded track |
| Everyone | server library downloads | play when YouTube is unreachable but the server is up |

Changes made while offline (plays, likes, playlist edits) are journaled in
an outbox and replayed in order when the server returns.

## 7. Maintenance

- **Updates**: Settings → Updates (admin). Source installs pull `origin/main`
  + pip deps; AppImage swaps itself with the newest release. The server
  restarts itself and the page reconnects.
- **YouTube broke overnight**: Settings → Updates → *Update yt-dlp only*.
- **Logs**: `journalctl -u osmp -f` (or the user-unit equivalent).
- **Database housekeeping**: history is capped at the last 5,000 plays
  automatically; no vacuuming needed at personal scale.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Playback stalls mid-track | usually stale yt-dlp → update it; check server logs for googlevideo 403s |
| Downloads fail, streams fine | ffmpeg missing — check Settings → server info |
| Lyrics "not found" for a hit song | LRCLIB may genuinely lack it; retries weekly. Check the server can reach `lrclib.net` |
| Client says offline but LAN is fine | check `curl http://<ip>:<port>/api/health`; the SW only falls back when fetch fails |
| Stats empty for a listener | stats are per-account — make sure they're logged in, not using the machine's browser profile of another user |
| AppImage won't start | `libfuse2` missing → `--appimage-extract-and-run` |
| 401 loops after password reset | sessions were revoked by design — sign in again |

## 9. Security notes

- Passwords: scrypt (N=2^14) in SQLite; sessions are 30-day sliding,
  revoked on password change/removal.
- The auth cookie is `HttpOnly` + `SameSite=Lax`; native clients use bearer
  tokens.
- Anything admin-gated (users, settings, updates, backup) checks the role
  server-side, not just in the UI.
- No telemetry, no outbound calls except YouTube (playback/import), LRCLIB
  (lyrics), and GitHub (updates, admin-triggered).
