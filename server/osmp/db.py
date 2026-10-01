"""SQLite persistence: track metadata cache, offline library, playlists, settings, history.

Every call opens its own short-lived connection (WAL mode), so this is safe to use
from FastAPI's threadpool and background threads alike.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .config import Config, get_config

_init_lock = threading.Lock()
_initialized = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks(
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT 'Unknown',
  duration    REAL,
  thumbnail   TEXT,
  file_path   TEXT,
  file_size   INTEGER,
  source      TEXT NOT NULL DEFAULT 'youtube',
  added_at    REAL NOT NULL,
  play_count  INTEGER NOT NULL DEFAULT 0,
  last_played REAL
);
CREATE TABLE IF NOT EXISTS playlists(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'user',
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks(
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL,
  position    INTEGER NOT NULL,
  added_at    REAL NOT NULL,
  PRIMARY KEY(playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS settings(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history(
  track_id TEXT NOT NULL,
  played_at REAL NOT NULL,
  user_id  TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_history_time ON history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_pt_pos ON playlist_tracks(playlist_id, position);
CREATE TABLE IF NOT EXISTS users(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pwhash     TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS lyrics(
  track_id     TEXT PRIMARY KEY,
  found        INTEGER NOT NULL DEFAULT 0,
  synced       TEXT,
  plain        TEXT,
  instrumental INTEGER NOT NULL DEFAULT 0,
  fetched_at   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS smart_playlists(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '✨',
  rules_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_shares(
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(playlist_id, user_id)
);
"""

_MIGRATIONS = (
    # v0.1.x databases have a user-less history table
    ("ALTER TABLE history ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'",),
)


_local = threading.local()


def _connect(cfg: Config) -> sqlite3.Connection:
    """One persistent connection per thread.

    Nested helpers (e.g. playlist_add_tracks -> upsert_track) must share a
    connection: two connections in one thread would deadlock on the write lock
    (the outer implicit transaction never commits while it waits on the inner).
    Cross-thread writers serialize via WAL + busy_timeout.
    """
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    conn = sqlite3.connect(cfg.db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    _local.conn = conn
    return conn


def init_db(cfg: Config | None = None) -> None:
    global _initialized
    cfg = cfg or get_config()
    with _init_lock:
        if _initialized:
            return
        with _connect(cfg) as conn:
            conn.executescript(SCHEMA)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(history)")}
            for stmt, in _MIGRATIONS:  # idempotent: skip if column already present
                if "user_id" in stmt and "user_id" in cols:
                    continue
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError:
                    pass  # already applied under a different shape
            # per-user playlists (v0.7.0): add owner to pre-existing tables and
            # hand every unowned playlist to the first admin
            pl_cols = {r[1] for r in conn.execute("PRAGMA table_info(playlists)")}
            if "owner_id" not in pl_cols:
                conn.execute(
                    "ALTER TABLE playlists ADD COLUMN owner_id INTEGER REFERENCES users(id)")
            conn.execute(
                """UPDATE playlists SET owner_id=
                     (SELECT MIN(id) FROM users WHERE role='admin' AND active=1)
                   WHERE owner_id IS NULL""")
        _initialized = True


# ---------------------------------------------------------------- tracks

def upsert_track(t: dict, cfg: Config | None = None) -> None:
    """Insert or refresh metadata for a track. Never clobbers library fields
    (file_path/file_size/play_count) when the incoming dict lacks them."""
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        conn.execute(
            """INSERT INTO tracks(id,title,artist,duration,thumbnail,source,added_at)
               VALUES(?,?,?,?,?,COALESCE(?, 'youtube'),?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title,
                 artist=excluded.artist,
                 duration=COALESCE(excluded.duration, tracks.duration),
                 thumbnail=COALESCE(excluded.thumbnail, tracks.thumbnail)""",
            (
                t["id"], t.get("title") or "Unknown", t.get("artist") or "Unknown",
                t.get("duration"), t.get("thumbnail"), t.get("source"), now,
            ),
        )


def get_track(track_id: str, cfg: Config | None = None) -> dict | None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    return dict(row) if row else None


def list_tracks(offline_only: bool = False, limit: int = 500, cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    q = "SELECT * FROM tracks"
    if offline_only:
        q += " WHERE file_path IS NOT NULL"
    q += " ORDER BY added_at DESC LIMIT ?"
    with _connect(cfg) as conn:
        rows = conn.execute(q, (limit,)).fetchall()
    return [dict(r) for r in rows]


def tracks_by_artist(artist: str, limit: int = 400,
                     cfg: Config | None = None) -> list[dict]:
    """Library tracks for one artist, most played first."""
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT * FROM tracks WHERE lower(artist) = lower(?)
               ORDER BY play_count DESC, last_played DESC NULLS LAST,
                        added_at DESC LIMIT ?""",
            (artist.strip(), limit)).fetchall()
    return [dict(r) for r in rows]


def artist_play_stats(artist: str, user_id: str | None = None,
                      cfg: Config | None = None) -> dict:
    """Lifetime play totals for an artist (all users unless scoped)."""
    cfg = cfg or get_config()
    scope, args = _history_scope(0, user_id)
    with _connect(cfg) as conn:
        row = conn.execute(
            f"""SELECT COUNT(*) AS plays,
                       COALESCE(SUM(t.duration), 0) AS seconds,
                       MAX(h.played_at) AS last_played
                FROM history h JOIN tracks t ON t.id = h.track_id
                WHERE {scope} AND lower(t.artist) = lower(?)""",
            args + [artist.strip()]).fetchone()
    return {"plays": row["plays"], "seconds": int(row["seconds"] or 0),
            "last_played": row["last_played"]}


def list_artists(limit: int = 100, cfg: Config | None = None) -> list[dict]:
    """Distinct artists in the library with track counts, for browse."""
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT artist, COUNT(*) AS tracks,
                      SUM(file_path IS NOT NULL) AS offline,
                      COALESCE(SUM(play_count), 0) AS plays
               FROM tracks GROUP BY lower(artist)
               ORDER BY plays DESC, tracks DESC LIMIT ?""",
            (limit,)).fetchall()
    return [dict(r) for r in rows]


def set_track_file(track_id: str, file_path: str | None, file_size: int | None,
                   cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute("UPDATE tracks SET file_path=?, file_size=? WHERE id=?",
                     (file_path, file_size, track_id))


def delete_track(track_id: str, cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute("DELETE FROM tracks WHERE id=?", (track_id,))
        conn.execute("DELETE FROM playlist_tracks WHERE track_id=?", (track_id,))
        conn.execute("DELETE FROM history WHERE track_id=?", (track_id,))


def record_play(track_id: str, user_id: str = "local", cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        conn.execute(
            "UPDATE tracks SET play_count=play_count+1, last_played=? WHERE id=?",
            (now, track_id))
        conn.execute("INSERT INTO history(track_id, played_at, user_id) VALUES(?,?,?)",
                     (track_id, now, user_id))
        # keep history bounded
        conn.execute(
            """DELETE FROM history WHERE rowid NOT IN
               (SELECT rowid FROM history ORDER BY played_at DESC LIMIT 5000)""")


def recent_history(limit: int = 12, user_id: str | None = None,
                   cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    q = """SELECT t.* FROM history h JOIN tracks t ON t.id=h.track_id
           {where} GROUP BY h.track_id ORDER BY MAX(h.played_at) DESC LIMIT ?"""
    if user_id:
        rows = _connect(cfg).execute(
            q.format(where="WHERE h.user_id=?"), (user_id, limit)).fetchall()
    else:
        rows = _connect(cfg).execute(q.format(where=""), (limit,)).fetchall()
    return [dict(r) for r in rows]


def history_log(limit: int = 200, user_id: str | None = None,
                 cfg: Config | None = None) -> list[dict]:
    """Raw play journal (newest first) — one row per play, unlike
    recent_history which dedupes by track."""
    cfg = cfg or get_config()
    q = """SELECT t.*, h.played_at FROM history h
           JOIN tracks t ON t.id = h.track_id
           {where} ORDER BY h.played_at DESC LIMIT ?"""
    if user_id:
        rows = _connect(cfg).execute(
            q.format(where="WHERE h.user_id=?"), (user_id, limit)).fetchall()
    else:
        rows = _connect(cfg).execute(q.format(where=""), (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- lyrics cache

def get_cached_lyrics(track_id: str, cfg: Config | None = None) -> dict | None:
    """Lyrics cache row or None; the caller applies the hit/miss TTL."""
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        row = conn.execute("SELECT * FROM lyrics WHERE track_id=?",
                           (track_id,)).fetchone()
    return dict(row) if row else None


def save_cached_lyrics(track_id: str, found: bool, synced: str | None,
                       plain: str | None, instrumental: bool = False,
                       cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute(
            """INSERT INTO lyrics(track_id, found, synced, plain, instrumental, fetched_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(track_id) DO UPDATE SET
                 found=excluded.found, synced=excluded.synced,
                 plain=excluded.plain, instrumental=excluded.instrumental,
                 fetched_at=excluded.fetched_at""",
            (track_id, int(found), synced, plain, int(instrumental), time.time()))


# ---------------------------------------------------------------- stats

def stats_summary(days: int = 30, user_id: str | None = None,
                  cfg: Config | None = None) -> dict:
    """Listening stats over a window.

    Minutes are estimated as plays × track duration — history rows record
    the start of a play, not how much of it was heard, so this is an upper
    bound that matches how Spotify-style dashboards approximate it.
    """
    cfg = cfg or get_config()
    since = time.time() - days * 86400
    scope, args = _history_scope(since, user_id)
    conn = _connect(cfg)
    total = conn.execute(
        f"""SELECT COUNT(*) AS plays,
                   COUNT(DISTINCT h.track_id) AS tracks,
                   COUNT(DISTINCT lower(t.artist)) AS artists,
                   COALESCE(SUM(t.duration), 0) AS seconds
            FROM history h JOIN tracks t ON t.id=h.track_id
            WHERE {scope}""", args).fetchone()
    top_tracks = conn.execute(
        f"""SELECT t.*, COUNT(*) AS plays,
                   MAX(h.played_at) AS last_played,
                   COALESCE(SUM(t.duration), 0) AS seconds
            FROM history h JOIN tracks t ON t.id=h.track_id
            WHERE {scope}
            GROUP BY h.track_id ORDER BY plays DESC, last_played DESC LIMIT 12""",
        args).fetchall()
    top_artists = conn.execute(
        f"""SELECT t.artist AS artist, COUNT(*) AS plays,
                   COUNT(DISTINCT h.track_id) AS tracks,
                   COALESCE(SUM(t.duration), 0) AS seconds,
                   MAX(h.played_at) AS last_played
            FROM history h JOIN tracks t ON t.id=h.track_id
            WHERE {scope}
            GROUP BY lower(t.artist) ORDER BY plays DESC LIMIT 8""",
        args).fetchall()
    return {
        "days": days,
        "plays": total["plays"],
        "tracks": total["tracks"],
        "artists": total["artists"],
        "seconds": int(total["seconds"] or 0),
        "top_tracks": [dict(r) for r in top_tracks],
        "top_artists": [dict(r) for r in top_artists],
    }


def stats_by_day(days: int = 30, user_id: str | None = None,
                 cfg: Config | None = None) -> list[dict]:
    """Plays + estimated seconds per local day, zero-filled for charting."""
    cfg = cfg or get_config()
    since = time.time() - days * 86400
    scope, args = _history_scope(since, user_id)
    with _connect(cfg) as conn:
        rows = conn.execute(
            f"""SELECT date(h.played_at, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS plays,
                       COALESCE(SUM(t.duration), 0) AS seconds
                FROM history h JOIN tracks t ON t.id=h.track_id
                WHERE {scope}
                GROUP BY day""", args).fetchall()
    by_day = {r["day"]: dict(r) for r in rows}
    out = []
    now = time.time()
    for i in range(days - 1, -1, -1):
        day = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
        hit = by_day.get(day)
        out.append({"day": day, "plays": hit["plays"] if hit else 0,
                    "seconds": int(hit["seconds"]) if hit else 0})
    return out


def stats_by_hour(user_id: str | None = None, cfg: Config | None = None) -> list[dict]:
    """Lifetime plays per local hour-of-day (24 buckets)."""
    cfg = cfg or get_config()
    scope, args = _history_scope(0, user_id)
    with _connect(cfg) as conn:
        rows = conn.execute(
            f"""SELECT CAST(strftime('%H', h.played_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                       COUNT(*) AS plays
                FROM history h WHERE {scope} GROUP BY hour""", args).fetchall()
    by_hour = {r["hour"]: r["plays"] for r in rows}
    return [{"hour": h, "plays": by_hour.get(h, 0)} for h in range(24)]


def _history_scope(since: float, user_id: str | None) -> tuple[str, list]:
    cond = ["h.played_at >= ?"]
    args: list = [since]
    if user_id:
        cond.append("h.user_id = ?")
        args.append(user_id)
    return " AND ".join(cond), args


# ---------------------------------------------------------------- backup

def export_library(cfg: Config | None = None) -> dict:
    """Everything needed to rebuild playlists on another instance.

    Deliberately excludes secrets (LLM keys, pins) and account data — this
    is a library backup, not a server clone.
    """
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        tracks = conn.execute(
            """SELECT id, title, artist, duration, thumbnail, play_count
               FROM tracks""").fetchall()
        playlists = conn.execute(
            """SELECT p.id, p.name, p.description, p.kind, p.created_at,
                      COALESCE(u.username, '') AS owner
               FROM playlists p LEFT JOIN users u ON u.id=p.owner_id
               ORDER BY p.created_at""").fetchall()
        entries = conn.execute(
            """SELECT playlist_id, track_id, position FROM playlist_tracks
               ORDER BY playlist_id, position""").fetchall()
        share_rows = conn.execute(
            """SELECT s.playlist_id, u.username, s.can_edit
               FROM playlist_shares s JOIN users u ON u.id=s.user_id""").fetchall()
    ids_by_pl: dict[int, list[str]] = {}
    for e in entries:
        ids_by_pl.setdefault(e["playlist_id"], []).append(e["track_id"])
    shares_by_pl: dict[int, list[dict]] = {}
    for s in share_rows:
        shares_by_pl.setdefault(s["playlist_id"], []).append(
            {"username": s["username"], "can_edit": bool(s["can_edit"])})
    settings = {k: v for k, v in all_settings(cfg).items()
                if k in _PUBLIC_SAFE}
    return {
        "tracks": [dict(t) for t in tracks],
        "playlists": [{**dict(p), "track_ids": ids_by_pl.get(p["id"], []),
                       "shares": shares_by_pl.get(p["id"], [])}
                      for p in playlists],
        "settings": settings,
    }


def import_library(data: dict, cfg: Config | None = None) -> dict:
    """Merge a backup into this instance: upsert track metadata, recreate any
    playlist whose (owner, name) pair doesn't exist yet, restore shares, and
    report what happened. Owners/shares are matched by username; unknown
    usernames fall back to the first admin (owner) or are skipped (shares)."""
    cfg = cfg or get_config()

    def uid_of(username: str | None) -> int | None:
        if not username:
            return None
        with _connect(cfg) as conn:
            row = conn.execute(
                "SELECT id FROM users WHERE username=? COLLATE NOCASE AND active=1",
                (username,)).fetchone()
        return row[0] if row else None

    track_meta = {}
    for t in data.get("tracks") or []:
        if isinstance(t, dict) and t.get("id"):
            track_meta[t["id"]] = t
            upsert_track(t, cfg)
    with _connect(cfg) as conn:
        existing = {(r["owner"] or "", r["name"]): r["id"] for r in conn.execute(
            """SELECT p.id, p.name, COALESCE(u.username, '') AS owner
               FROM playlists p LEFT JOIN users u ON u.id=p.owner_id""")}
    fallback_admin: int | None = None
    with _connect(cfg) as conn:
        row = conn.execute(
            "SELECT MIN(id) FROM users WHERE role='admin' AND active=1").fetchone()
        fallback_admin = row[0] if row else None
    created, merged, skipped = 0, 0, 0
    for pl in data.get("playlists") or []:
        name = (pl.get("name") or "").strip()
        ids = [i for i in (pl.get("track_ids") or []) if i in track_meta]
        if not name:
            continue
        owner_name = pl.get("owner") or ""
        owner_id = uid_of(owner_name) or fallback_admin
        key = (owner_name, name)
        if key in existing:
            pid = existing[key]
            existing_ids = {t["id"] for t in
                            (get_playlist(pid, cfg) or {}).get("tracks", [])}
            add = [i for i in ids if i not in existing_ids]
            if add:
                playlist_add_tracks(pid, [track_meta[i] for i in add], cfg)
                merged += 1
            else:
                skipped += 1
        else:
            pid = create_playlist(name, pl.get("description") or "",
                                  pl.get("kind") or "user", owner_id, cfg)
            if ids:
                playlist_add_tracks(pid, [track_meta[i] for i in ids], cfg)
            existing[key] = pid
            created += 1
        # shares (matched by username; owner and unknown users skipped)
        share_ids = []
        for s in pl.get("shares") or []:
            if not isinstance(s, dict):
                continue
            uid = uid_of(s.get("username"))
            if uid and uid != owner_id:
                share_ids.append((uid, bool(s.get("can_edit"))))
        if share_ids:
            set_shares(pid, share_ids, cfg)
    for key, value in (data.get("settings") or {}).items():
        if key in _PUBLIC_SAFE:
            set_setting(key, value, cfg)
    return {"playlists_created": created, "playlists_merged": merged,
            "playlists_unchanged": skipped}


# ---------------------------------------------------------------- playlists

def create_playlist(name: str, description: str = "", kind: str = "user",
                    owner_id: int | None = None,
                    cfg: Config | None = None) -> int:
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        if owner_id is None:  # legacy callers — hand to the first admin
            row = conn.execute(
                "SELECT MIN(id) FROM users WHERE role='admin' AND active=1").fetchone()
            owner_id = row[0] if row else None
        cur = conn.execute(
            "INSERT INTO playlists(name, description, kind, owner_id, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?)",
            (name.strip() or "Untitled", description.strip(), kind, owner_id, now, now))
        return int(cur.lastrowid)


def list_playlists(cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT p.*, COUNT(pt.track_id) AS track_count,
                      COALESCE(SUM(t.duration),0) AS total_duration
               FROM playlists p
               LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id
               LEFT JOIN tracks t ON t.id=pt.track_id
               GROUP BY p.id ORDER BY p.updated_at DESC""").fetchall()
    return [dict(r) for r in rows]


def get_playlist(playlist_id: int, cfg: Config | None = None) -> dict | None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        prow = conn.execute("SELECT * FROM playlists WHERE id=?", (playlist_id,)).fetchone()
        if not prow:
            return None
        trows = conn.execute(
            """SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id
               WHERE pt.playlist_id=? ORDER BY pt.position ASC""", (playlist_id,)).fetchall()
        urow = conn.execute("SELECT username FROM users WHERE id=?",
                            (prow["owner_id"],)).fetchone()
    pl = dict(prow)
    pl["owner"] = urow["username"] if urow else None
    pl["tracks"] = [dict(r) for r in trows]
    pl["track_count"] = len(pl["tracks"])
    pl["total_duration"] = sum(t.get("duration") or 0 for t in pl["tracks"])
    return pl


def list_playlists_for_user(user_id: int, cfg: Config | None = None) -> list[dict]:
    """The playlists a user may see: their own (first) + ones shared with them.

    is_mine/can_edit come straight from SQL so the API layer can pass them
    through untouched.
    """
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT p.*, u.username AS owner,
                     (p.owner_id = :uid) AS is_mine,
                     (CASE WHEN p.owner_id = :uid THEN 1
                           ELSE COALESCE(s.can_edit, 0) END) AS can_edit,
                     COUNT(pt.track_id) AS track_count,
                     COALESCE(SUM(t.duration),0) AS total_duration
               FROM playlists p
               JOIN users u ON u.id = p.owner_id
               LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id
               LEFT JOIN tracks t ON t.id=pt.track_id
               LEFT JOIN playlist_shares s ON s.playlist_id=p.id AND s.user_id=:uid
               WHERE p.owner_id = :uid OR s.user_id = :uid
               GROUP BY p.id
               ORDER BY is_mine DESC, p.updated_at DESC""",
            {"uid": user_id}).fetchall()
    return [dict(r) for r in rows]


def get_share(playlist_id: int, user_id: int,
              cfg: Config | None = None) -> dict | None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        row = conn.execute(
            "SELECT * FROM playlist_shares WHERE playlist_id=? AND user_id=?",
            (playlist_id, user_id)).fetchone()
    return dict(row) if row else None


def list_shares(playlist_id: int, cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT s.user_id, u.username, s.can_edit
               FROM playlist_shares s JOIN users u ON u.id=s.user_id
               WHERE s.playlist_id=? ORDER BY u.username""", (playlist_id,)).fetchall()
    return [dict(r) for r in rows]


def set_shares(playlist_id: int, shares: list[tuple[int, bool]],
               cfg: Config | None = None) -> None:
    """Replace the whole share set: shares = [(user_id, can_edit), ...]."""
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute("DELETE FROM playlist_shares WHERE playlist_id=?", (playlist_id,))
        for uid, can_edit in shares:
            conn.execute(
                "INSERT OR IGNORE INTO playlist_shares(playlist_id, user_id, can_edit) "
                "VALUES(?,?,?)", (playlist_id, uid, 1 if can_edit else 0))


def update_playlist(playlist_id: int, name: str | None = None, description: str | None = None,
                    cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    fields, args = [], []
    if name is not None:
        fields.append("name=?"); args.append(name.strip() or "Untitled")
    if description is not None:
        fields.append("description=?"); args.append(description.strip())
    if not fields:
        return False
    fields.append("updated_at=?"); args.append(time.time()); args.append(playlist_id)
    with _connect(cfg) as conn:
        cur = conn.execute(f"UPDATE playlists SET {', '.join(fields)} WHERE id=?", args)
    return cur.rowcount > 0


def delete_playlist(playlist_id: int, cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (playlist_id,))
        cur = conn.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))
    return cur.rowcount > 0


def playlist_add_tracks(playlist_id: int, tracks: list[dict], cfg: Config | None = None) -> int:
    """Append tracks (full metadata dicts); skips duplicates already in the playlist."""
    cfg = cfg or get_config()
    now = time.time()
    added = 0
    with _connect(cfg) as conn:
        exists = conn.execute("SELECT 1 FROM playlists WHERE id=?", (playlist_id,)).fetchone()
        if not exists:
            return 0
        existing = {r[0] for r in conn.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id=?", (playlist_id,))}
        maxpos = conn.execute(
            "SELECT COALESCE(MAX(position),0) FROM playlist_tracks WHERE playlist_id=?",
            (playlist_id,)).fetchone()[0]
        for t in tracks:
            upsert_track(t, cfg)
            if t["id"] in existing:
                continue
            maxpos += 1
            conn.execute(
                "INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES(?,?,?,?)",
                (playlist_id, t["id"], maxpos, now))
            existing.add(t["id"])
            added += 1
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (now, playlist_id))
    return added


def playlist_remove_track(playlist_id: int, track_id: str, cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        cur = conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",
            (playlist_id, track_id))
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (time.time(), playlist_id))
    return cur.rowcount > 0


def playlist_reorder(playlist_id: int, ordered_ids: list[str], cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        for pos, tid in enumerate(ordered_ids, start=1):
            conn.execute(
                "UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?",
                (pos, playlist_id, tid))
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (time.time(), playlist_id))
    return True


# ---------------------------------------------------------------- smart playlists

def query_rows(sql: str, args: list | tuple = (),
               cfg: Config | None = None) -> list[dict]:
    """Parameterized read for other modules (smart playlists). The SQL text
    must come from whitelisted fragments — never from user input."""
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def create_smart(name: str, rules_json: str, emoji: str = "✨",
                 cfg: Config | None = None) -> int:
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        cur = conn.execute(
            "INSERT INTO smart_playlists(name, emoji, rules_json, created_at, updated_at) "
            "VALUES(?,?,?,?,?)", (name.strip() or "Untitled", emoji or "✨", rules_json, now, now))
        return int(cur.lastrowid)


def list_smart(cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            "SELECT * FROM smart_playlists ORDER BY created_at ASC").fetchall()
    return [dict(r) for r in rows]


def get_smart(sid: int, cfg: Config | None = None) -> dict | None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        row = conn.execute("SELECT * FROM smart_playlists WHERE id=?", (sid,)).fetchone()
    return dict(row) if row else None


def update_smart(sid: int, name: str | None = None, rules_json: str | None = None,
                 emoji: str | None = None, cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    fields, args = [], []
    if name is not None:
        fields.append("name=?"); args.append(name.strip() or "Untitled")
    if rules_json is not None:
        fields.append("rules_json=?"); args.append(rules_json)
    if emoji is not None:
        fields.append("emoji=?"); args.append(emoji or "✨")
    if not fields:
        return False
    fields.append("updated_at=?"); args.append(time.time()); args.append(sid)
    with _connect(cfg) as conn:
        cur = conn.execute(f"UPDATE smart_playlists SET {', '.join(fields)} WHERE id=?", args)
    return cur.rowcount > 0


def delete_smart(sid: int, cfg: Config | None = None) -> bool:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        cur = conn.execute("DELETE FROM smart_playlists WHERE id=?", (sid,))
    return cur.rowcount > 0


# ---------------------------------------------------------------- settings

_PUBLIC_SAFE = {"theme", "accent", "default_format"}


def get_setting(key: str, default=None, cfg: Config | None = None):
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return row[0]


def set_setting(key: str, value, cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)))


def all_settings(cfg: Config | None = None) -> dict:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = {}
    for r in rows:
        try:
            out[r[0]] = json.loads(r[1])
        except (json.JSONDecodeError, TypeError):
            out[r[0]] = r[1]
    return out
