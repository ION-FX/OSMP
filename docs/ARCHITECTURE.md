# OSMP architecture

## Layout

```
server/          Python package (FastAPI). The only server code.
  osmp/
    main.py      app assembly, middleware, static UI mount
    api.py       all REST routes
    youtube.py   every yt-dlp call lives here (search/resolve/download/mixes)
    radio.py     recommendation-graph playlist generation
    llm.py       OpenAI-compatible curator client
    db.py        SQLite (WAL, thread-local connections)
    config.py    data dirs + ffmpeg discovery
webui/           the SPA. Vanilla ES modules, zero build step, no npm.
  js/            app/api/store/player/router/theme + views/ + components/
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
live server and live YouTube: boot, search, real playback (asserting
`currentTime` advances), pause/resume, repeat modes, shuffle, seek, volume,
queue drawer, sleep timer, now-playing overlay, radio generation, playlist
save, all three themes — with screenshots and a console-error gate.
