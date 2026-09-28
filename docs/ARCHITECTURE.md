# OSMP architecture

## Layout

```
server/          Python package (FastAPI). The only server code.
  osmp/
    main.py      app assembly, middleware, static UI mount
    api.py       all REST routes
    youtube.py   every yt-dlp call lives here (search/resolve/download/import)
    radio.py     recommendation-graph playlist generation
    llm.py       OpenAI-compatible curator client
    lyrics.py    LRCLIB client + LRC parser (SQLite-cached)
    db.py        SQLite (WAL, thread-local connections)
    auth.py      accounts/sessions (scrypt, cookie + bearer)
    update.py    self-update (source/AppImage) + yt-dlp refresh
    config.py    data dirs + ffmpeg discovery
webui/           the SPA. Vanilla ES modules, zero build step, no npm.
  js/            app/api/store/player/router/theme + views/ + components/
  js/lyrics.js   synced-lyrics overlay (rAF follow loop)
  js/eq.js       Web Audio graph: 3-band EQ + analyser tap
  js/visualizer.js  canvas bars driven by the analyser
  css/           base (tokens/themes) · layout · components · player
  sw.js          app-shell cache (API + audio never cached)
android/         Gradle project, framework-only Java (no androidx, no Kotlin).
desktop/         Qt WebEngine shell (PyInstaller → AppImage).
scripts/         build_appimage.sh · build_android.sh · ui_test.py · make_icons.py
```

## Streaming

`GET /api/stream/{video_id}` is a **Range-aware proxy**:

1. `youtube.resolve_stream()` asks yt-dlp for the best audio-only format
   (`m4a` preferred for universal playback; `opus` selectable) and caches the
   resulting googlevideo URL for ~5 h.
2. The client's `Range` header is forwarded upstream; the 206 response
   (Content-Range/Content-Length) is passed through untouched, so the HTML5
   `<audio>` element seeks natively.
3. On upstream 403/410/429 the cache entry is invalidated and the request is
   retried once with a freshly resolved URL — transparent expiry recovery.

Offline files (`/api/library/stream/{id}`) are served with Starlette's
FileResponse, which implements the same single-range semantics.

## Radio algorithm (`radio.py`)

1. **Seed** — an 11-char id seeds directly; free text becomes a search and the
   top 3 hits seed.
2. **Expand** — each seed's YouTube *Mix/Radio* playlist (`list=RD<id>`) is
   fetched flat (YouTube's own recommendation graph, one request each, in
   parallel). A hop-2 round over the three strongest hop-1 candidates deepens
   the pool; artist/query searches widen it.
3. **Filter** — drop lives, unknown durations, <60 s or >15 min items, and
   duplicates by a normalized title key (parentheticals and junk words like
   "official audio", "remaster 2011" stripped).
4. **Shape** — score = hop distance × position-in-mix + jitter seeded by the
   seed string (stable but varied); greedy selection enforces ≤2 tracks per
   artist inside a sliding window of 8; the three strongest tracks open the
   list, the rest is shuffled within their band.

No API keys, no scraping of private endpoints — only public playlist/search
extraction through yt-dlp.

## Lyrics (`lyrics.py`)

1. **Clean** — YouTube titles are noisy: strip `- Topic` / `VEVO` from
   artists, split the common `Artist - Title` shape, remove bracketed
   release clutter (`(Official Video)`, `[4K Remaster]`, `(feat. …)`).
2. **Fetch** — LRCLIB's exact-match `/get` answer joins the `/search`
   candidate pool (it can be a vandalized entry while search holds healthy
   copies); candidates must pass a sanity gate (≥5 synced lines or ≥80
   chars of plain text) and are ranked: synced > plain, exact title,
   artist containment, duration proximity.
3. **Cache** — hits persist 90 days, misses 7 (so hopeless tracks retry
   weekly); network errors are never cached as misses. The `lyrics` table
   is one row per track id.

The client (`webui/js/lyrics.js`) renders `[{t, line}]` as clickable
paragraphs; a rAF loop finds the active line by binary scan of
`audio.currentTime`, centers it (suppressed for ~3.5 s after real user
scroll input — wheel/touchmove, since programmatic `scrollTo` also fires
`scroll` events).

## Audio graph (`webui/js/eq.js`)

Built lazily on first slider/preset interaction (a gesture is required to
start an AudioContext, and `createMediaElementSource` only works once per
element — ever):

```
<audio> → lowshelf 180 Hz → peaking 1.4 kHz → highshelf 5.2 kHz → destination
                                      └→ analyser (visualizer tap)
```

The analyser is a dead-end tap, so visualizing with a flat EQ changes
nothing. If the context suspends (backgrounding), the player resumes it on
every `playing` event — a suspended context means total silence once the
graph exists.

## Stats (`db.py` + `views/stats.js`)

History rows record `(track_id, played_at, user_id)`. Stats aggregate over
a window: plays, distinct tracks/artists, estimated minutes (plays × track
duration — an upper bound, since we log starts not completions), per-local-day
zero-filled series, and a lifetime hour-of-day histogram. Charts are
hand-rolled inline SVG (viewBox 760×H, bar-per-day/hour, `<title>`
tooltips) — no chart library. Admins may query `scope=all`; listeners are
pinned to their own rows server-side.

## LLM curator (`llm.py`)

Any OpenAI-compatible `POST {base}/chat/completions`. The system prompt forces
a strict JSON tracklist; the parser tolerates markdown fences and chatter.
Each pick is resolved with a single-result YouTube search in a 4-wide pool;
unresolvable picks are reported, never fatal.

## Offline model

- **Server-side**: `POST /api/library/download` runs yt-dlp into
  `data/library/`, tags the file (mutagen) and embeds the cover; the track row
  gains `file_path`, and every client prefers the local stream.
- **Android**: `DownloadStore` saves into app-private storage. The WebView
  intercepts `https://offline.osmp.local/{id}` (incl. Range → 206) and serves
  the local file, so the *same* web UI plays downloads with zero network. The
  JS bridge (`window.OsmpBridge`) also drives wake lock and the media
  notification.
- **Browser PWA**: the service worker caches only the app shell and
  thumbnails; audio always comes from the server (which may itself serve its
  offline library).

## Concurrency notes

- SQLite: WAL + one connection per thread. Nested helpers share the thread's
  connection — two connections in one thread would deadlock on the write lock.
- yt-dlp is blocking; routes that call it are sync `def` so FastAPI's
  threadpool absorbs them. Radio fans out with `ThreadPoolExecutor(4)`.

## Packaging

- **AppImage**: PyInstaller onedir (server + webui + static ffmpeg + Qt
  WebEngine) → AppDir → `appimagetool`. `--no-sandbox` Chromium flag is set
  because AppImages cannot use the setuid sandbox. `--smoke` boots the server
  and loads the UI on the offscreen platform for headless CI.
- **APK**: AGP 8.5.2, `compileSdk 34`, framework-only Java — the dependency
  list is intentionally empty, so the build needs nothing from Maven beyond
  the Android Gradle plugin itself.

## Testing

`scripts/ui_test.py` drives headless Chromium (Playwright, Python) against a
live server and live YouTube: boot, login gate, search, real playback
(asserting `currentTime` advances), pause/resume, repeat modes, shuffle
(including the picked-track-first regression), seek, volume, queue drawer,
sleep timer, now-playing overlay, radio generation, playlist save, import,
all three themes, stats, artist pages, synced-lyrics highlighting, EQ,
playback speed, history — 49 checks with screenshots and a console-error
gate.

`scripts/api_test.py` covers the HTTP surface of the v0.3.0 features:
lyrics resolution + caching, stats shape/guards, mixes, artists, the
history log, backup export/import round-trip, and the 401/403/role guards
around them (30 checks).
