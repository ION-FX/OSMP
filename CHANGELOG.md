# Changelog

## v0.3.0 — 2026-09-28

The "knows your music" release: lyrics, stats, artist pages, sound shaping,
and backups — plus the shuffle fix everyone hits eventually.

### Fixed
- **Shuffle no longer hijacks track picks.** With shuffle on, clicking a
  song in a playlist/radio/search now starts *that* song and shuffles what
  comes after it; only the header "Shuffle" button picks a random opener.
- Player bar survives page reloads again (a restored session kept the bar
  hidden until the next play).
- Moving the volume slider during a sleep-timer fade no longer gets stomped
  by the next fade step.
- Lyrics: YouTube titles like `Artist - Song (4K Remaster)` now resolve
  (artist prefix split + smarter noise stripping), and vandalized LRCLIB
  entries (lone `probe` line) can never win over healthy copies.

### Added
- **Synced lyrics** (LRCLIB, free & keyless) — karaoke-style highlighting,
  click-a-line-to-seek, auto-follow that pauses while you scroll, graceful
  plain/offline states. Server-side SQLite cache (90-day hits, weekly miss
  retries). Toggle: player bar button, now-playing, or `L`.
- **Stats view** — plays/minutes/tracks/artists summary, listening-by-day
  bars with streaks, hour-of-day "listening clock", top artists (→ radio)
  and top tracks, 7/30/90/365-day ranges, admin-only all-users scope.
- **Full play history** — `#/history`, every play grouped by day.
- **Made for you** — Home shelf of artist radio mixes built from your
  actual plays, plus a "downloaded, never played" shelf.
- **Artist pages** — every artist name is a link; page shows your tracks by
  that artist (play/shuffle/radio/download-all) with play counts.
- **Equalizer** — 3-band Web Audio EQ, 7 presets + Custom, live, persisted
  per device (Settings → Sound).
- **Visualizer** — frequency-bar canvas in the now-playing overlay (taps
  the EQ graph's analyser; simulated fallback when Web Audio is blocked).
- **Playback speed** — 0.75×–2×, pitch-preserved, `.`/`,` keys or the
  now-playing chip.
- **Playlist tools** — display sorts (title/artist/recently added/longest)
  and "Download all" with sequential queueing and progress on the button.
- **Queue** — "Clear upcoming" keeps the current track, drops the rest.
- **Sleep timer** — new "End of queue" mode (EOQ badge).
- **Radio** — "Surprise me" rolls a random seed from 28 moods/decades.
- **Backup & restore** — admin export of playlists + track metadata +
  safe settings to JSON; import merges by name. Secrets and accounts never
  leave the server.
- **Keyboard shortcuts** — `L` `S` `Q` `/` `.` `,` and `?` for the help
  overlay.
- **Library** — Artists section linking to the new artist pages.

### Internals
- New tables: `lyrics` (cache). New endpoints: `GET /api/lyrics/{id}`,
  `/api/stats`, `/api/mixes`, `/api/artist`, `/api/artists`,
  `/api/history/log`, `/api/backup`, `POST /api/backup/restore`.
- Service-worker shell cache v5 → v6.
- Test suites: UI 31 → 49 checks; new API suite (30 checks) covering
  lyrics/stats/mixes/artists/history/backup and their auth guards.

## v0.2.1 — 2026-09-27

- Account recovery from the server shell: `--list-users`,
  `--reset-password USER`, `--create-admin` (safe while the server runs).
- Installer NEXT STEPS points at recovery commands.

## v0.2.0 — 2026-09-27

The client/server release: OSMP became a Nextcloud-style box you own.

- Accounts & sessions (scrypt, cookie + bearer, 30-day sliding), first-run
  admin setup, admin-managed users with roles, per-user play history.
- One-command installer (`curl | sudo bash`) with systemd unit, rootless
  mode, and private-repo token support.
- Offline-first clients: service-worker audio cache, offline shell,
  outbox journaling that syncs plays/likes/edits on reconnect.
- Desktop AppImage became a connect-or-host client (localhost reverse
  proxy for service workers); Android gained login + session seeding.

## v0.1.2 — 2026-09-26

- YouTube playlist / album / channel / @handle import with preview +
  per-track selection; Search and Radio route pasted links to the importer.

## v0.1.1 — 2026-09-26

- In-app updater (source + AppImage), yt-dlp quick refresh, GitHub token
  setting, stream format preference, PWA polish.

## v0.1.0 — 2026-09-25

- First release: server (FastAPI + yt-dlp + SQLite), web UI, radio engine,
  LLM curator, downloads, playlists, themes, sleep timer, queue,
  Android APK, Linux AppImage.
