# Changelog

## v0.7.0 — 2026-09-30

The per-user playlists release: every account gets their own lists, and
sharing turns them collaborative when you want.

### Added
- **Playlists are per-person.** Each account's sidebar shows their own
  playlists (plus a "Shared with you" section when applicable); the same
  playlist name can exist in several accounts — including "Liked", which is
  now per-user instead of one global bucket every listener's hearts fell into.
- **Sharing with permissions.** A playlist's owner opens Share, picks any
  account, and grants view or can-edit. Editors add/remove/reorder tracks;
  renaming, deleting and re-sharing stay with the owner. Unshared lists are
  invisible to everyone else (404, not 403 — existence isn't leaked).
- **Share dialog** on every owned playlist: add accounts from a picker,
  toggle can-edit, remove, save the whole set at once.
- Library and home cards show "by <owner>" on playlists that aren't yours;
  the add-to-playlist picker only offers lists you can edit.
- Backups now carry owner + shares (matched by username on restore).

### Internals
- `playlists.owner_id` (migrated in place: existing playlists went to the
  first admin) + `playlist_shares` table; deleting an account removes its
  playlists and share rows via cascades.
- New routes: `PUT /api/playlists/{id}/share` (owner-only) and
  `GET /api/users/brief` (share picker); all playlist routes now
  permission-checked. `/api/home` playlists are scoped too.
## v0.6.0 — 2026-09-30

The Windows release: the desktop client now ships for Windows too, built
and smoke-tested by CI on real Windows machines.

### Added
- **osmp-windows-x64.zip** — the same Qt desktop client as the AppImage,
  for Windows. Built by a GitHub Actions workflow (`.github/workflows/
  windows.yml`) that runs the PyInstaller build **and the smoke test on a
  genuine windows-latest runner**, bundles a static ffmpeg.exe, and
  attaches the zip to every version-tagged release.
- `scripts/build_windows.ps1` — the Windows build (PowerShell twin of the
  AppImage script, including the bundled-ffmpeg step).
- README: Windows setup + server-only-on-Windows instructions.

### Windows compatibility
- Data directory: `%LOCALAPPDATA%\OSMP` (server) / `%APPDATA%\osmp`
  (desktop config) instead of the POSIX `~/.local/share` paths.
- ffmpeg discovery understands `ffmpeg.exe` and the frozen vendor dir.
- uvicorn runs under the Windows selector event loop (the Proactor default
  breaks its asyncio/websockets loop); all subprocess use stays synchronous.
- Self-update knows the "windows-exe" mode: Settings reports the build,
  update checks work, and apply explains that Windows updates by
  downloading the new zip (yt-dlp refresh still works in place).
## v0.5.4 — 2026-09-30

Codebase bug sweep — visual and functional fixes across all three clients.

### Fixed
- **Android on-device downloads never worked**: the web UI handed the native
  downloader a server-relative URL (`/api/stream/…`), which Java's
  `java.net.URL` rejects outright. URLs are now resolved against the server
  origin in the UI (with a native fallback for older cached pages).
- **Android downloads saved opus streams as .m4a** — the container is now
  derived from the stream's `fmt` parameter, so the file gets the right
  extension and MIME type.
- **The Like heart never rendered filled** — `setIcon()` dropped its fill
  argument, so the button looked identical whether the track was liked.
- **Sleep-timer ring never drained** — the moon button's countdown circle
  stayed invisible for the whole timer because its progress was never set.
- **Toasts could get pinned forever** — hovering one cancelled its
  auto-dismiss with no resume; leaving now restarts the countdown.
- **Scrub bar stuck in grab state** when a pointer gesture was cancelled
  mid-drag (e.g. touch stolen by a scroll) — now cleaned up on pointercancel.
- **Radio from an uploaded track** (now-playing screen) seeded the radio
  with its internal `local_…` id and produced garbage — it now seeds with
  artist + title like the track menu does.
- **Android crash risk**: link handling dereferenced the URI scheme without
  a null check (malformed/intent URIs could kill the app).
## v0.5.3 — 2026-09-29

Fixed: the Linux AppImage played nothing at all.

### Fixed
- **Root cause**: Qt WebEngine (shipped in the PySide6 wheels the AppImage
  is built from) comes without proprietary codecs — it cannot decode AAC
  in m4a. The server's "auto" format hands every stream over as m4a, so
  every track errored instantly on desktop while Chrome and Android
  WebView (which have AAC) played fine.
- **Codec negotiation**: the client now probes `canPlayType` once and
  "auto" means "what this device can play" — m4a when supported, opus
  otherwise. An explicit format choice in Settings still wins.
- **Local files transcode when needed**: downloaded/uploaded tracks are
  usually m4a; AAC-less clients now get a live opus transcode from the
  server's ffmpeg (`/api/library/stream/{id}?fmt=opus`). Already-free
  formats (opus/ogg/mp3/flac) are served as before, with ranges.
## v0.5.2 — 2026-09-29

Android notification fix.

### Fixed
- **The media notification now keeps showing the current track.** It used
  to drop the title/artist ("just says OSMP") the moment playback started,
  because some client updates reported only the playing flag and the
  notification rebuilt itself with empty metadata. The web player now
  always reports the full state (title, artist, cover, playing), and the
  Android service merges partial payloads with the last known state as
  belt-and-braces for cached older UIs.
- A slow cover-art download could repaint the notification with the
  *previous* track's title after you skipped. Stale art results are now
  discarded when the track changed meanwhile.
## v0.5.1 — 2026-09-29

Playback resilience fix.

### Fixed
- **Streams that fail once are now retried instead of skipped.** YouTube
  briefly refuses track resolves at times (bot checks during rapid
  queueing); the client used to give up after a single error, toast
  "Can't play — skipping" and move on. Every track now gets one silent
  second attempt ~2s later (with a cache-buster), which recovers these
  transients on all clients.
- After four consecutive failures playback now stops with one clear
  message instead of toasting its way through the whole queue (the
  failure counter no longer resets when a skipped track loads).
## v0.5.0 — 2026-09-29

The smart playlist release: lists that maintain themselves.

### Added
- **Smart playlists** — saved rule sets that rebuild themselves from your
  library every time you open or play them. Rules combine on play count,
  last-played/added dates, length, artist/title text, source
  (YouTube vs uploaded) and downloaded state, matched with all/any logic,
  then ordered (most played, recently played/added, random, A–Z) and
  capped (1–500 tracks).
- **Ready-made presets** — Most played, On repeat, Deeper cuts (never
  played), Recently added and Your uploads start from one click in the
  Library view or the editor.
- **Live match preview** — the editor shows "N tracks match · total time"
  as you type, computed by the same server-side query the playlist uses.
- Library view gains a Smart playlists section with auto-updating cards;
  each playlist has Play / Shuffle / Download all / Edit rules / Delete.

### Internals
- New module `server/osmp/smart.py` — whitelisted field/op validation and
  parameterized SQL (user input never becomes SQL text), plus a
  `smart_playlists` table and `/api/smart` CRUD + `/api/smart/preview` +
  `/api/smart/presets` endpoints.
- Evaluation happens on the server, so Android and desktop clients get
  smart playlists with no client-side logic.

## v0.4.0 — 2026-09-29

The "your own music" release: OSMP is now a real library, not just a
YouTube frontend.

### Added
- **Upload your own music** — any signed-in user can upload MP3/M4A/FLAC/
  OGG/Opus/WAV/AAC files from the Library view. Tags (title/artist/album/
  duration) and embedded cover art are read automatically; uploads become
  first-class tracks that stream through the library pipeline, mix into
  playlists alongside YouTube tracks, count in stats, and work with
  "save to this device".
- **Import a whole folder (server-side, admin)** — Settings → "Import your
  collection" scans any directory on the server and copies every audio
  file into the library. Nothing is moved or deleted from the source.
- Duplicate detection (same duration + size + title) keeps re-uploads and
  re-scans from doubling your library.
- Search now shows "From your library" matches above YouTube results.
- Radio from an uploaded track seeds with its artist + title.
- Removing an uploaded track removes the track itself (YouTube downloads
  keep their metadata as before).
- Cover art endpoint `/api/art/{id}` serves extracted tag images.

### Internals
- New module `server/osmp/upload.py`; new endpoints `POST /api/upload`
  (multipart), `POST /api/upload/scan` (admin), `GET /api/art/{id}`.
- Local tracks use `local_`-prefixed ids so they can never collide with
  YouTube video ids; deletion of uploads is full-track.
- Dependency: `python-multipart` (multipart form parsing).
- Service-worker shell cache v6 → v7. Tests: API suite 39 → 49 checks,
  UI suite 54 → 57.

## v0.3.0 — 2026-09-28 — 2026-09-28

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
