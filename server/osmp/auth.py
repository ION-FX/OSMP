"""User accounts + sessions. Stdlib-only (hashlib.scrypt).

Design:
- Passwords: scrypt with per-user random salt, stored as "salthex$hashhex".
- Sessions: random 48-hex tokens in SQLite (30-day sliding expiry), so logins
  survive server restarts. The same token works as a cookie (web) or as an
  Authorization: Bearer header (Android / desktop clients).
- First admin is created via POST /api/setup, which only answers while the
  users table is empty — after that the server is locked to logins.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time

from .config import Config, get_config

SESSION_TTL = 30 * 24 * 3600
COOKIE = "osmp_session"

# in-memory cache of "do any users exist" — setup mode is checked on every
# unauthenticated request, this keeps it off SQLite
_users_known: bool | None = None


# ---------------------------------------------------------------- passwords

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"{salt.hex()}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, h_hex = stored.split("$", 1)
        h = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                           n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(h.hex(), h_hex)
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------- users

def _conn(cfg: Config | None = None) -> sqlite3.Connection:
    from . import db
    return db._connect(cfg or get_config())


def user_count(cfg: Config | None = None) -> int:
    global _users_known
    row = _conn(cfg).execute("SELECT COUNT(*) FROM users WHERE active=1").fetchone()
    n = row[0]
    _users_known = n > 0
    return n


def setup_required(cfg: Config | None = None) -> bool:
    if _users_known is not None:
        return not _users_known
    return user_count(cfg) == 0


def create_user(username: str, password: str, role: str = "user",
                cfg: Config | None = None) -> dict:
    username = (username or "").strip()
    if not (1 <= len(username) <= 32):
        raise ValueError("username must be 1-32 characters")
    if len(password or "") < 4:
        raise ValueError("password must be at least 4 characters")
    if role not in ("admin", "user"):
        role = "user"
    conn = _conn(cfg)
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO users(username, pwhash, role, active, created_at) VALUES(?,?,?,1,?)",
                (username, hash_password(password), role, time.time()))
    except sqlite3.IntegrityError as exc:
        raise ValueError("that username is taken") from exc
    global _users_known
    _users_known = True
    return get_user(cur.lastrowid, cfg)


def get_user(user_id: int, cfg: Config | None = None) -> dict | None:
    row = _conn(cfg).execute(
        "SELECT id, username, role, active, created_at FROM users WHERE id=?",
        (user_id,)).fetchone()
    return dict(row) if row else None


def find_user(username: str, cfg: Config | None = None) -> dict | None:
    row = _conn(cfg).execute(
        "SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
    return dict(row) if row else None


def list_users(cfg: Config | None = None) -> list[dict]:
    rows = _conn(cfg).execute(
        "SELECT id, username, role, active, created_at FROM users ORDER BY created_at ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def set_password(user_id: int, password: str, cfg: Config | None = None) -> None:
    if len(password or "") < 4:
        raise ValueError("password must be at least 4 characters")
    with _conn(cfg) as conn:
        conn.execute("UPDATE users SET pwhash=? WHERE id=?",
                     (hash_password(password), user_id))


def set_role(user_id: int, role: str, cfg: Config | None = None) -> None:
    if role not in ("admin", "user"):
        raise ValueError("bad role")
    with _conn(cfg) as conn:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))


def set_active(user_id: int, active: bool, cfg: Config | None = None) -> None:
    with _conn(cfg) as conn:
        conn.execute("UPDATE users SET active=? WHERE id=?", (1 if active else 0, user_id))


def admin_count(cfg: Config | None = None) -> int:
    return _conn(cfg).execute(
        "SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]


def delete_user(user_id: int, cfg: Config | None = None) -> None:
    """Remove a user, their sessions/history and their playlists (shares and
    track links cascade). The last admin cannot be deleted."""
    victim = get_user(user_id, cfg)
    if victim and victim["role"] == "admin" and admin_count(cfg) <= 1:
        raise ValueError("cannot delete the last admin")
    with _conn(cfg) as conn:
        conn.execute("DELETE FROM playlists WHERE owner_id=?", (user_id,))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM history WHERE user_id=?", (user_id,))


# ---------------------------------------------------------------- sessions

def create_session(user_id: int, cfg: Config | None = None) -> str:
    token = secrets.token_hex(24)
    with _conn(cfg) as conn:
        conn.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)",
            (token, user_id, time.time(), time.time() + SESSION_TTL))
    return token


def session_user(token: str | None, cfg: Config | None = None) -> dict | None:
    """Resolve a token to its active user, sliding the expiry forward."""
    if not token:
        return None
    conn = _conn(cfg)
    row = conn.execute(
        """SELECT u.id, u.username, u.role, u.active, s.token
           FROM sessions s JOIN users u ON u.id=s.user_id
           WHERE s.token=? AND s.expires_at > ?""", (token, time.time())).fetchone()
    if not row or not row["active"]:
        return None
    # sliding expiry — committed immediately: this runs in the auth middleware
    # on the event-loop thread, so a leaked transaction would freeze all writers
    with conn:
        conn.execute("UPDATE sessions SET expires_at=? WHERE token=?",
                     (time.time() + SESSION_TTL, token))
    return {"id": row["id"], "username": row["username"],
            "role": row["role"], "token": row["token"]}


def drop_session(token: str | None, cfg: Config | None = None) -> None:
    if token:
        with _conn(cfg) as conn:
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def drop_user_sessions(user_id: int, cfg: Config | None = None) -> None:
    """Sign a user out everywhere (used after password resets)."""
    with _conn(cfg) as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def purge_expired(cfg: Config | None = None) -> None:
    with _conn(cfg) as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
