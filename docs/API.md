# OSMP REST API

For self-hosters who want to script their server (or build a client).
All routes are prefixed with `/api`. Examples assume
`OSMP=http://your-server:8543`.

## Authentication

Browser sessions use an `HttpOnly` cookie; scripts and native clients use a
bearer token — both come from the same login:

```bash
TOKEN=$(curl -s -X POST $OSMP/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "admin", "password": "…"}' | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" $OSMP/api/health
```

Sessions slide (30 days from last use) and survive restarts. Everything
below requires auth unless noted. Admin-only routes answer `403` for
listeners, `401` when unauthenticated.

## Meta

| Route | Notes |
|---|---|
| `GET /health` | no auth. `{"ok": true, "time": …}` |
| `GET /config` | no auth. version, setup_required, server_name, current user, llm/ffmpeg flags |
| `POST /setup` | no auth, one-shot. `{username, password, name?}` creates the admin |
| `POST /auth/login` | `{username, password}` → `{token, user}` + cookie |
| `POST /auth/logout` | drops the session |
| `GET /auth/me` | current user or null |

## Discovery

| Route | Notes |
|---|---|
| `GET /search?q=&limit=20` | YouTube search; results enriched with `offline` |
| `GET /track/{id}` | metadata (resolves and caches unknown ids) |
| `POST /resolve` | `{ids: [≤50]}` → metadata map |
| `POST /import/preview` | `{url}` → `{preview_id, items, …}` for playlists/albums/channels |
| `POST /import/apply` | `{preview_id, name, track_ids?}` → creates a playlist |

## Playback & library

| Route | Notes |
|---|---|
| `GET /stream/{id}` | Range-aware audio proxy (206 passthrough) |
| `GET /library/stream/{id}` | serves a downloaded file |
| `POST /library/download` | `{video_id, title, artist}` → `{job_id}` |
| `GET /library/jobs/{job_id}` | `{status, progress, error?}` |
| `GET /library?offline_only=` | library tracks |
| `DELETE /library/{id}` | removes the download |
| `POST /history` | `{track_id}` — records a play for the current user |

## Playlists

| Route | Notes |
|---|---|
| `GET /playlists` | list with counts |
| `POST /playlists` | `{name, description?, kind?}` |
| `GET /playlists/{id}` | full playlist incl. ordered tracks |
| `PATCH /playlists/{id}` | rename / redescription |
| `DELETE /playlists/{id}` | |
| `POST /playlists/{id}/tracks` | `{tracks: [metadata dicts]}` (appends, dedupes) |
| `DELETE /playlists/{id}/tracks/{track_id}` | |
| `PUT /playlists/{id}/tracks` | `{order: [ids]}` — full reorder |

## Radio & AI

| Route | Notes |
|---|---|
| `GET /radio/generate?seed=&count=25` | recommendation-graph mix (id, artist or mood) |
| `POST /radio/llm` | `{prompt, count=20}` — needs a configured LLM (`428` otherwise) |

## Lyrics

`GET /lyrics/{track_id}` — never a hard 404 for "unknown words"; the shape
carries the outcome:

```json
{"track_id": "…", "found": true, "synced": true,
 "lines": [{"t": 19.67, "line": "We're no strangers to love"}, …],
 "plain": "…", "instrumental": false, "source": "lrclib"}
```

`found: false` carries a human-readable `reason`. Results are cached
server-side (hits 90 days, misses retried after a week); network failures
are not cached. Metadata is resolved from the library cache first, then
live via yt-dlp.

## Your own music (uploads)

| Route | Notes |
|---|---|
| `POST /upload` | multipart `file` field; mp3/m4a/flac/ogg/opus/wav/aac. Tags and embedded art are read server-side; duplicates answer `409`. Returns `{ok, track}` |
| `POST /upload/scan` | admin. `{path}` — copies every audio file under a server-side directory into the library (never moves/deletes). Returns counts + first 500 imported tracks |
| `GET /art/{track_id}` | the cover extracted at upload time; `404` when none |

```bash
curl -H "Authorization: Bearer $TOKEN" -F "file=@song.mp3" $OSMP/api/upload
```

Uploaded tracks have `source: "local"` and ids like `local_ab12…`. They
stream via `/api/library/stream/{id}` like any download; deleting one
removes the track entirely.

## Smart playlists

Rule-based lists evaluated against the track cache on every read — they
update themselves.

| Route | Notes |
|---|---|
| `GET /smart` | all smart playlists with spec, human summary, live `track_count`/`total_duration` |
| `POST /smart` | `{name, emoji, spec}` — create; invalid rules → `400` |
| `GET /smart/{id}` | definition + evaluated `tracks` (what playback queues) |
| `PATCH /smart/{id}` | rename, re-emoji, re-spec |
| `DELETE /smart/{id}` | remove the rules; tracks/playlists untouched |
| `POST /smart/preview` | spec only → `{count, seconds, summary}` of everything the rules match (before the limit) — powers the editor's live counter |
| `GET /smart/presets` | the five built-in starter specs |

Spec shape (fields/ops are whitelisted server-side; values are always bound
parameters, never SQL text):

```json
{
  "match": "all",
  "rules": [
    {"field": "plays", "op": "gte", "value": 5},
    {"field": "last_played", "op": "within", "value": 7},
    {"field": "source", "op": "is", "value": "local"}
  ],
  "order": "most_played",
  "limit": 50
}
```

| Field | Ops | Value |
|---|---|---|
| `plays` | `gte` `lte` `eq` | play count |
| `last_played` / `added` | `within` `before` (`never` on last_played) | days |
| `duration` | `gte` `lte` | seconds (unknown counts as 0) |
| `artist` / `title` | `contains` `is` | text |
| `source` | `is` | `youtube` \| `local` |
| `offline` | `is` | boolean |

`order`: `most_played` · `recently_played` · `recently_added` · `random` ·
`title` · `artist`. `limit`: 1–500.

## Stats, mixes, history

| Route | Notes |
|---|---|
| `GET /stats?days=30&scope=me` | summary + `top_tracks`/`top_artists` + zero-filled `by_day` + `by_hour`. `days` clamped to 1–365; `scope=all` requires admin, others are pinned to `me` |
| `GET /mixes` | "Made for you" cards (SQLite-only, cheap), `jump_back_in`, `fresh` |
| `GET /artist?name=X` | your tracks by that artist + play stats |
| `GET /artists?q=` | distinct artists with track/play counts |
| `GET /history/log?limit=200` | raw play journal, newest first, with `played_at` |

Notes: "minutes" are estimated as plays × track duration (history logs
starts, not completions). Day buckets use the server's local timezone.

## Backup & restore (admin)

```bash
curl -H "Authorization: Bearer $TOKEN" $OSMP/api/backup -o osmp-backup.json
```

Export contains `format: "osmp-backup"`, all track metadata, playlists with
ordered ids, and public-safe settings — never accounts, sessions, LLM keys
or tokens. Restore merges by playlist name:

```bash
curl -X POST $OSMP/api/backup/restore \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq '{data: .}' osmp-backup.json)"
# → {"ok": true, "playlists_created": n, "playlists_merged": n, "playlists_unchanged": n}
```

## Users (admin)

| Route | Notes |
|---|---|
| `GET /users` | list |
| `POST /users` | `{username, password, role: "user"\|"admin"}` |
| `POST /users/{id}/password` | reset (self-change drops your session) |
| `DELETE /users/{id}` | also deletes their history |

## Settings & updates (admin to change)

| Route | Notes |
|---|---|
| `GET /settings` | secrets come back masked as `***set***` |
| `PUT /settings` | partial patch of allowed keys |
| `POST /update/check` | compare against GitHub releases |
| `POST /update/apply` | `{kind: "full"\|"ytdlp"}` → `{job_id}` |
| `GET /update/status/{job_id}` | log lines + phase |

## Status codes

| Code | Meaning |
|---|---|
| `400` | bad input (e.g. empty artist name, foreign backup format, mix link into the importer) |
| `401` | not signed in |
| `403` | signed in but not admin / setup already done |
| `404` | unknown resource (also: track gone from YouTube) |
| `428` | LLM route with no LLM configured |
| `502` | upstream failure (yt-dlp, LRCLIB unreachable) |

## Rate-limit reality check

There is none — OSMP assumes a household. Don't expose it directly to the
internet; put it behind a VPN or an authenticating reverse proxy.
