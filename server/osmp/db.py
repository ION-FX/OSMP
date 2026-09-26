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
  played_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_time ON history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_pt_pos ON playlist_tracks(playlist_id, position);
"""


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


def record_play(track_id: str, cfg: Config | None = None) -> None:
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        conn.execute(
            "UPDATE tracks SET play_count=play_count+1, last_played=? WHERE id=?",
            (now, track_id))
        conn.execute("INSERT INTO history(track_id, played_at) VALUES(?,?)", (track_id, now))
        # keep history bounded
        conn.execute(
            """DELETE FROM history WHERE rowid NOT IN
               (SELECT rowid FROM history ORDER BY played_at DESC LIMIT 5000)""")


def recent_history(limit: int = 12, cfg: Config | None = None) -> list[dict]:
    cfg = cfg or get_config()
    with _connect(cfg) as conn:
        rows = conn.execute(
            """SELECT t.* FROM history h JOIN tracks t ON t.id=h.track_id
               GROUP BY h.track_id ORDER BY MAX(h.played_at) DESC LIMIT ?""",
            (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- playlists

def create_playlist(name: str, description: str = "", kind: str = "user",
                    cfg: Config | None = None) -> int:
    cfg = cfg or get_config()
    now = time.time()
    with _connect(cfg) as conn:
        cur = conn.execute(
            "INSERT INTO playlists(name, description, kind, created_at, updated_at) VALUES(?,?,?,?,?)",
            (name.strip() or "Untitled", description.strip(), kind, now, now))
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
    pl = dict(prow)
    pl["tracks"] = [dict(r) for r in trows]
    pl["track_count"] = len(pl["tracks"])
    pl["total_duration"] = sum(t.get("duration") or 0 for t in pl["tracks"])
    return pl


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
