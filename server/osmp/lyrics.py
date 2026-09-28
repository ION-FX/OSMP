"""Time-synced lyrics via LRCLIB (https://lrclib.net) — free, keyless.

Flow per track: exact ``/api/get`` lookup first, then a fuzzy ``/api/search``
with candidate scoring (synced beats plain, duration proximity and artist
containment break ties). Results are memoized in SQLite: hits live for 90
days, misses for one week so hopeless tracks aren't re-queried on every open
but can still recover when the community adds them.

Network errors are never cached as misses — the next open retries.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any

import httpx

from . import db
from .config import Config, get_config

log = logging.getLogger("osmp.lyrics")

_BASE = "https://lrclib.net/api"
_HEADERS = {
    # LRCLIB asks clients to identify themselves; keep it honest and generic
    "User-Agent": "OSMP-self-hosted-music (https://github.com/ION-FX/OSMP)",
    "Accept": "application/json",
}
_TIMEOUT = httpx.Timeout(12.0, connect=5.0)

HIT_TTL = 90 * 24 * 3600   # a found lyric is basically immutable
MISS_TTL = 7 * 24 * 3600   # retry "no lyrics" weekly

# any bracketed group holding one of these words is release clutter —
# search keys match far better once it's gone. Matches combined forms like
# "(4K Remaster)" or "(Official Music Video)".
_NOISE_RE = re.compile(
    r"\s*[\(\[][^\)\]]*\b(?:official|video|audio|lyrics?|visualizer|"
    r"remaster(?:ed)?|hd|hq|4k|2160p|mv|full\s+album|color\s+coded|"
    r"sub\s+espa[nñ]ol|subbed|videoclip)\b[^\)\]]*[\)\]]\s*",
    re.IGNORECASE)
_FEAT_RE = re.compile(r"\s*\(?\s*(?:ft|feat|featuring)\.?\s+[^)\]]*\)?\s*$",
                      re.IGNORECASE)
_TOPIC_RE = re.compile(r"\s*[-–]\s*Topic$")
_VEVO_RE = re.compile(r"\s*VEVO$", re.IGNORECASE)


def split_artist_title(title: str, artist: str) -> str:
    """YouTube music titles are usually 'Artist - Real Title'."""
    if artist:
        prefix = f"{artist.strip()} - "
        if title.lower().startswith(prefix.lower()):
            return title[len(prefix):]
    return title


def clean_title(title: str) -> str:
    t = _NOISE_RE.sub(" ", (title or "").strip())
    t = _FEAT_RE.sub("", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def clean_artist(artist: str) -> str:
    a = _TOPIC_RE.sub("", (artist or "").strip())
    a = _VEVO_RE.sub("", a)
    return re.sub(r"\s{2,}", " ", a).strip()


# ---------------------------------------------------------------- LRC parsing

_LRC_STAMP_RE = re.compile(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_LRC_LINE_RE = re.compile(r"((?:\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)")


def parse_lrc(text: str | None) -> list[dict]:
    """LRC body → sorted ``[{t, line}]``.

    Multi-timestamp lines (``[00:12.00][01:30.00]chorus``) explode into one
    entry per stamp; blank lyric lines are kept — the UI renders them as
    breathing room between sections.
    """
    out: list[dict] = []
    for raw in (text or "").splitlines():
        m = _LRC_LINE_RE.match(raw.strip())
        if not m:
            continue
        stamps, line = m.groups()
        for mm, ss, frac in _LRC_STAMP_RE.findall(stamps):
            ms = int((frac or "0").ljust(3, "0"))  # ".5" → 500ms
            out.append({"t": int(mm) * 60 + int(ss) + ms / 1000,
                        "line": line.strip()})
    out.sort(key=lambda x: x["t"])
    return out


# ---------------------------------------------------------------- fetching

def _duration(track: dict) -> int | None:
    try:
        d = float(track.get("duration") or 0)
    except (TypeError, ValueError):
        return None
    return int(d) if d > 0 else None


def _best(cands: list[dict], title: str, artist: str,
          dur: int | None) -> dict | None:
    if not cands:
        return None

    def score(c: dict) -> float:
        s = 3.0 if c.get("syncedLyrics") else 0.0
        cand_title = (c.get("trackName") or "").lower().strip()
        cand_artist = (c.get("artistName") or "").lower().strip()
        if title and cand_title == title.lower():
            s += 2
        if artist:
            if artist.lower() in cand_artist or cand_artist in artist.lower():
                s += 2
        if dur and c.get("duration"):
            gap = abs(c["duration"] - dur)
            if gap <= 5:
                s += 2
            elif gap <= 15:
                s += 1
        if c.get("instrumental"):
            s -= 0.5  # "(instrumental)" entries rarely help real tracks
        return s

    return max(cands, key=score)


def _usable(hit: dict | None) -> bool:
    """Reject placeholder / vandalized entries — LRCLIB occasionally serves a
    lone ``[00:00.00]probe`` line even on its exact-match endpoint."""
    if not hit:
        return False
    if hit.get("syncedLyrics") and len(parse_lrc(hit["syncedLyrics"])) >= 5:
        return True
    plain = (hit.get("plainLyrics") or "").strip()
    return len(plain) >= 80


def _fetch(track: dict) -> tuple[str, dict | None]:
    """Returns ``(status, hit)`` with status in {"hit", "miss", "error"}.

    The exact-match ``/get`` answer joins the ``/search`` candidate pool
    rather than winning outright — it can be a junk entry while the search
    index holds healthy copies of the same song.
    """
    artist = clean_artist(track.get("artist", ""))
    title = clean_title(split_artist_title(track.get("title", ""), artist))
    if not title:
        return "miss", None
    dur = _duration(track)
    params: dict[str, Any] = {"track_name": title, "artist_name": artist}
    cands: list[dict] = []
    try:
        with httpx.Client(base_url=_BASE, headers=_HEADERS, timeout=_TIMEOUT,
                          follow_redirects=True) as http:
            try:
                r = http.get("/get",
                             params={**params, "duration": dur} if dur else params)
                if r.status_code == 200 and _usable(r.json()):
                    cands.append(r.json())
            except httpx.HTTPError:
                log.warning("lyrics /get failed for %r", title)

            try:
                r = http.get("/search", params=params)
                if r.status_code == 200:
                    cands += [c for c in r.json() if _usable(c)]
            except (httpx.HTTPError, ValueError):
                log.warning("lyrics /search failed for %r", title)
    except httpx.HTTPError as exc:
        log.warning("lyrics fetch failed for %r: %s", title, exc)
        return "error", None
    best = _best(cands, title, artist, dur)
    return ("hit", best) if best else ("miss", None)


# ---------------------------------------------------------------- public API

def _row_to_out(track_id: str, row: dict | None) -> dict:
    if not row or not row["found"]:
        return {"track_id": track_id, "found": False,
                "reason": "No lyrics found for this track"}
    lines = parse_lrc(row["synced"])
    return {
        "track_id": track_id,
        "found": True,
        "synced": bool(lines),
        "lines": lines,
        "plain": row["plain"] or "",
        "instrumental": bool(row["instrumental"]),
        "source": "lrclib",
    }


def get_lyrics(track: dict, cfg: Config | None = None,
               force_refresh: bool = False) -> dict:
    """Lyrics for a track dict (``{id, title, artist, duration}``).

    Served from cache when fresh; otherwise fetched from LRCLIB and cached.
    Never raises for "not found" — that's a normal ``{"found": false}`` shape.
    """
    cfg = cfg or get_config()
    track_id = track.get("id") or track.get("track_id") or ""
    if not track_id:
        return {"track_id": "", "found": False, "reason": "unknown track"}

    if not force_refresh:
        row = db.get_cached_lyrics(track_id, cfg)
        if row:
            ttl = HIT_TTL if row["found"] else MISS_TTL
            if time.time() - row["fetched_at"] < ttl:
                return _row_to_out(track_id, row)

    status, hit = _fetch(track)
    if status == "hit" and hit is not None:
        db.save_cached_lyrics(
            track_id, True, hit.get("syncedLyrics"), hit.get("plainLyrics"),
            bool(hit.get("instrumental")), cfg)
    elif status == "miss":
        db.save_cached_lyrics(track_id, False, None, None, False, cfg)
    # "error" → uncached: retry next open

    row = db.get_cached_lyrics(track_id, cfg)
    if row:
        return _row_to_out(track_id, row)
    return {"track_id": track_id, "found": False,
            "reason": "Couldn't reach the lyrics service"}
