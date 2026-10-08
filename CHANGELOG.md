# Changelog

## v0.7.7 — 2026-10-08

### Fixed — Android downloads (verified end-to-end)
- **Uploaded tracks could not be downloaded to the device**: the download
  URL builder forced every track onto the YouTube stream endpoint, but
  uploads have `local_*` ids that only exist in the server library —
  those downloads failed. Server-stored tracks now download from the
  library endpoint (also faster and independent of YouTube).
- Session-cookie lookup (which the v0.7.5 UI-thread latch made safe)
  now falls back to a direct read if the latch times out on a wedged
  main thread — same guard in the Android Auto playback path.
- The download worker itself was verified against a real server by
  running the unmodified Java code in a harness: authenticated download
  produces real audio bytes (ftyp), correct mime/ranges for offline
  playback, index persistence across restarts, duplicate-submission
  guard, .part cleanup on failure, and no-cookie attempts fail with
  HTTP 401 (the auth gate working as intended). Two new UI checks pin
  the YouTube-vs-library URL routing.

## v0.7.6 — 2026-10-06

### Added — time bar on the phone player
- The player bar now shows the seek bar with elapsed / total time on
  phones and narrow tablets (≤900px) — previously it was hidden and the
  only way to see or scrub position was opening the full Now Playing
  screen. The bar sits between the transport buttons and the track row,
  and touch-scrubbing works (verified: tapping at 80% of a 4:07 track
  seeks to ~3:16). Two new regression checks pin it down: bar visible
  with both timestamps, and a tap seeks the audio.

## v0.7.5 — 2026-10-06

Fixes for the two things that were still broken on phones: the queue was
unreachable, and device downloads could fail silently.

### Fixed — queue on the phone (the real root cause)
- **The queue drawer opened underneath the Now Playing overlay.** The
  drawer lived inside `#app` (a z-index:1 stacking context) while the
  overlay sits at body level (z-index 300), so no z-index on the drawer
  could ever win. Since the phone's only queue button lives in the
  overlay, opening the queue did nothing visible and taps fell through
  to whatever was behind it. The drawer + backdrop now live at body
  level (above the Now Playing and lyrics overlays, below modals and
  menus). This affected desktop too whenever the queue was opened from
  the Now Playing overlay.
- **Queue reorder now works on touch**: long-press (~0.3s) an item to
  lift it, drag, release to drop — HTML5 drag-and-drop never fires on
  touch screens, so phones previously had no way to reorder at all.
  Mouse drag is unchanged.
- Regression-tested: the suite now opens the queue through the overlay
  on a 390px touch viewport, asserts the drawer is actually on top, and
  taps an item to confirm it plays.

### Fixed — Android downloads
- The session cookie is now read on the UI thread (with a latch and a
  cached fallback) both in the download bridge and in the new Auto
  playback path — calling CookieManager directly from a WebView bridge
  thread throws on some devices, which would have made downloads 401
  again even with v0.7.4.
- A failed device download now toasts the worker's actual error (e.g.
  "HTTP 401") instead of a bare "failed".
- Reminder: the Android app does not self-update — install the new APK
  from the Releases page; downloads have been broken on-device since
  server auth existed until v0.7.4 (401) for anyone on an older build.

## v0.7.4 — 2026-10-06

The car release: Android Auto / Bluetooth AVRCP media browsing, plus a
native playback path so OSMP plays even when the app UI isn't running.

### Added — Android Auto & Bluetooth browsing (Android)
- The media service now exposes a real browse tree: **Recently played,
  Playlists, Artists, Uploads** — playlists and artists expand to their
  tracks on the head unit. Voice search ("play X on OSMP") hits server
  search and starts the queue.
- **Native playback**: when the phone UI isn't alive (the normal case in
  a car), the service itself streams from the server with a MediaPlayer
  (m4a/AAC first, opus fallback), owns the queue, handles next/prev/seek,
  audio focus (duck/pause), headphone-unplug pause, and its own wake
  lock. Opening the phone app and pressing play hands playback back to
  the web UI; swiping the app away no longer kills car playback.
- Lock-screen/notification media state now carries real position and
  duration (visible as a seekbar on cars and Bluetooth metadata), and
  the transport protocol gained `seek:<sec>` plus a working `noop`
  re-announce after page reloads.
- Security: the browse root is only handed to the app itself, Android
  Auto, and platform-signed clients (system Bluetooth, Automotive).
- Zero new dependencies — built on the framework `MediaBrowserService`.
  Note: real head-unit behavior needs testing on actual hardware (or
  Android Studio's Desktop Head Unit); the service contract, manifest
  wiring, endpoints, and auth path are verified here.

### Fixed — Android
- **On-device downloads were silently failing with 401**: the server
  gates every `/api` path behind auth, but the download worker sent no
  credentials. It now rides the WebView's session cookie — same for the
  new native playback path.

## v0.7.3 — 2026-10-06

The phone release: a full mobile-viewport pass (390 px, touch) over every
view and overlay, driven by screenshots and geometry checks.

### Fixed — "can't choose a song with shuffle on"
- Tapping slightly low on a track row hit the invisible artist-link zone
  that runs through the middle of every row — instead of playing your
  song, the app navigated to the artist page. On touch devices the artist
  line is no longer a link (the whole row plays); artist pages are
  reachable via the row's ⋮ menu → **Go to artist** (new, works
  everywhere). Verified: shuffle on + row tap plays exactly the tapped
  track.

### Fixed — mobile layout
- **Player bar**: the track title/artist were hidden outright on phones,
  leaving a lone cover thumbnail and dead space. The title is back
  (single line, ellipsized), volume/queue/lyrics buttons make room.
- **Top bar**: settings + the account chip wrapped below the 56 px bar and
  icons overflowed. The bar is compact now and everything fits; the
  account chip lives in **Settings → Account** (new section with
  signed-in name + Sign out — the chip itself no longer fits).
- **Playlist/album/artist headers**: the hero shrank from a centered
  ~148 px cover stack into a compact row (cover left, title/actions
  right) — track lists start one screen higher.
- **Track rows**: tighter grid, bigger thumbs, no wasted gap before the
  duration; the uppercase column header is gone on phones.
- **Hover-only controls were invisible on touch**: the per-row download
  button, card play buttons and the queue-drawer remove (✕) only
  appeared on hover — permanently hidden on phones. All three are simply
  visible on touch devices.
- **Now-Playing overlay**: the action-button row had no wrap and overflowed
  the screen; it wraps into two tidy rows now.
- **Queue drawer**: header buttons fit one row again.
- Modals, heroes and empty states use phone-appropriate padding; all
  views verified free of horizontal overflow at 390 px.

### Tests
- New mobile section in the UI suite (phone viewport): overflow checks on
  every view, gear visibility, sign-out presence, shuffle + row-tap
  behavior, bar title visibility, hover-less affordances — 75 → 83 checks.

## v0.7.2 — 2026-10-04

Full-codebase bug sweep (six parallel audits: server core, server services,
web UI core, web UI views, Android, desktop/scripts) — 30+ defects found and
fixed. Highlights below.

### Security
- **Password resets kept attacker sessions alive**: resetting a user's
  password (admin lockout flow) invalidated nothing — every existing session
  of that account stayed valid for up to 30 days. All sessions are now
  dropped on any password change.
- **Stored XSS via thumbnails**: track/playlist thumbnail URLs came from
  server data (and restoreable backup files) and were interpolated into
  `src="…"` unescaped across the tracklist, player, queue drawer, playlist,
  artist, import, stats and history views — a crafted thumbnail value could
  break out of the attribute and run script. All 11 interpolation sites are
  escaped now, as are the crash-page message and smart-playlist covers.
- **Smaller holes**: update-job logs are admin-only; the home shelf no
  longer leaks the server-wide playlist count; the last-admin guard and
  first-run setup claim are race-safe.

### Data integrity
- **Plays of search results vanished from stats**: playing a track found
  via search recorded a history row for a track the server had never
  stored — and every stats/history/top-artist query joins on the tracks
  table, silently dropping those plays. The player now sends track metadata
  with each play so first-time tracks land in the library.
- **Backups restored play counts as zero** (the field was exported but
  never imported); restore now keeps the higher of local/backup counts.
- **Concurrent downloads corrupted files**: double-clicking download
  spawned two yt-dlp processes writing the same `.part` file (server), and
  two Android workers could do the same; both sides now dedupe. Deleting a
  track mid-download no longer resurrects it when the worker finishes.
- **Saved offline audio was wiped on every update**: the service worker's
  activate handler deleted *all* caches including the audio/image ones
  while the "saved on this device" flags survived — offline playback 404'd
  after each shell update. Only stale shell versions are removed now.

### Playback & UI
- Skipping a broken track no longer cancels a track you started during the
  900 ms skip delay; the one-shot resume-seek can no longer leak onto a
  different track; the sleep-timer fade no longer advances into (and then
  kills) the next track; removing a queued track no longer discards your
  drag-reordered order; OS media-key handlers are state-guarded and the
  OS playback state stays in sync; reopening the now-playing overlay within
  its 280 ms close animation no longer gets hidden underneath you.
- The sleep-timer countdown no longer ticks forever if the dialog is
  dismissed with Escape; offline likes apply immediately with a "syncs
  when back online" note instead of erroring; localStorage-blocked
  browsers boot and play instead of dying at startup.
- Search and Import views actually unmount now (their debounce/abort
  hooks were dead code — searches kept firing after navigation); the
  Library view tolerates navigating away mid-load; rapid radio generations
  no longer race; "Load more" in History keeps your scroll position.
- Mobile: the two-row player bar no longer covers the bottom of the page,
  queue drawer and toasts (`--player-h` now matches reality), and the
  Settings gear icon is visible again on phones.

### Server services
- **Lyrics outage poisoned the cache**: a network failure to LRCLIB was
  cached as a 7-day "no lyrics" miss (even forcing a refresh re-poisoned
  it). Real outages are no longer cached; genuinely lyric-less tracks
  still are. Malformed lyric responses no longer 500 the endpoint.
- **AppImage self-update could leave the server down**: the relaunch
  script dropped the `--local` flag, so an updated desktop could pop the
  connect dialog headless with the old process already gone. The desktop
  also persists flag-driven modes now, so a relaunch restores the same
  setup. "Update yt-dlp only" no longer pretends to succeed inside
  packaged builds (it can't — the interpreter is the app binary).
- Update jobs refuse to run concurrently; the stream-URL cache no longer
  grows unbounded; the LLM curator tolerates non-object API responses.

### Android
- **Sticky-restart crash**: if the OS killed the process while playing,
  the restarted media service hit its null-state early-return without
  calling `startForeground()` — a deterministic `ForegroundServiceDidNotStart`
  crash. It now promotes first and stops cleanly when there's nothing to show.
- The playback wakelock is released on pause (it used to be held up to
  four hours after playback stopped); the destroyed activity no longer
  leaks through the service's static host (notification controls die with
  the UI); the cover-art thread pool shuts down.
- **Back-button trap on the offline page**: Back looped between error
  pages and the Retry button reloaded the local error page instead of the
  server. Back now exits; Retry actually re-dials the server. SSL-warning
  dialogs appear once per session instead of stacking per resource;
  external-link detection compares hosts exactly (a server at 10.0.0.23
  no longer swallows links to 10.0.0.2).

### Desktop & install
- **First-run crash**: the connect dialog created a QApplication and the
  main path created a second one — PySide6 aborts the process on the
  second construction, so a fresh install died right after "Connect".
  One application object is created and reused; the single-instance name
  is also claimed before boot (two simultaneous launches can't both
  double-boot), the smoke test can no longer pass vacuously against a
  stale instance socket (and the AppImage build asserts `SMOKE_OK`), and
  malformed CLI flags print usage instead of a traceback.
- The systemd unit's sandbox now follows the chosen data directory
  (custom `--dir` installs used to crash-loop under `ProtectHome`), the
  installer accepts "degraded" systemd states (any server with one failed
  unit used to silently skip service setup), and its health check probes
  the address it actually bound.

## v0.7.1 — 2026-10-04

The idle-resource release: the desktop client no longer burns a CPU core
(or stacks duplicate processes) while you're not using it.

### Fixed
- **Idle CPU**: the desktop client kept compositing at full speed with
  nothing happening — the aurora background drifted forever (forcing every
  blurred surface to re-render at 60fps) and the progress bar ran a
  requestAnimationFrame loop writing DOM even while paused. Decorative
  animation now freezes whenever nothing is playing, and the progress bar
  is event-driven (rAF only while audio actually plays, text updates only
  when the displayed value changes). Verified: the "doing nothing" state
  no longer produces any UI damage.
- **Duplicate instances**: the window closes to the tray, so launching the
  AppImage again used to start a *second* full process (each bundling a Qt
  engine — and in local mode a whole server). A single-instance guard now
  focuses the running window instead; launching again brings OSMP to the
  front.

If your desktop had been showing multi-GB memory use, check the tray —
pre-update instances may have piled up; quitting them (or logging out)
clears it, and the guard prevents new ones.
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
