"""All YouTube access goes through this module (yt-dlp wrapper).

Design notes:
- Stream URLs are cached (~5 h) and invalidated on upstream 403/410 so a single
  retry transparently recovers from expiry.
- Blocking yt-dlp calls are fine here: routes that use them are declared `def`
  (not `async def`) so FastAPI runs them in its threadpool.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Callable

import yt_dlp

from .config import get_config

log = logging.getLogger("osmp.youtube")

THUMB_URL = "https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
URL_CACHE_TTL = 5 * 3600  # googlevideo URLs live ~6 h; refresh earlier

# format preference per client request: m4a/AAC plays literally everywhere
# (Safari included), opus/webm is slightly higher quality on Chromium clients.
_FORMATS = {
    "auto": "bestaudio[ext=m4a]/bestaudio[acodec^=opus]/bestaudio/best",
    "m4a": "bestaudio[ext=m4a]/bestaudio/best",
    "opus": "bestaudio[acodec^=opus]/bestaudio/best",
}

_url_cache: dict[tuple[str, str], dict] = {}
_cache_lock = threading.Lock()


class YouTubeError(Exception):
    """Base for extraction problems we surface to clients."""


class TrackUnavailable(YouTubeError):
    """Video cannot be played (removed, private, age-gated, region-locked...)."""


class ResolveError(YouTubeError):
    """Extraction failed in a possibly-transient way (network, YouTube change...)."""


def is_video_id(s: str) -> bool:
    return bool(VIDEO_ID_RE.match(s or ""))


def _base_opts(**overrides) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": True,
        "retries": 2,
        "extractor_retries": 1,
        "socket_timeout": 20,
    }
    ffmpeg = get_config().ffmpeg_path
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    opts.update(overrides)
    return opts


def _translate(exc: Exception, vid: str) -> YouTubeError:
    msg = str(exc)
    low = msg.lower()
    if any(k in low for k in ("private video", "removed", "unavailable", "not available",
                              "age-restrict", "sign in to confirm", "members-only",
                              "premieres", "copyright")):
        return TrackUnavailable(f"{vid}: {msg[:200]}")
    return ResolveError(f"{vid}: {msg[:200]}")


def _entry_to_track(e: dict) -> dict | None:
    """Normalize a (flat) yt-dlp entry into our track dict, or None if unusable."""
    vid = e.get("id") or ""
    if not is_video_id(vid):
        url = e.get("url") or e.get("webpage_url") or ""
        m = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", url)
        vid = m.group(1) if m else ""
    if not is_video_id(vid):
        return None
    title = e.get("title") or "Unknown title"
    return {
        "id": vid,
        "title": title,
        "artist": e.get("uploader") or e.get("channel") or e.get("artist") or "Unknown artist",
        "duration": e.get("duration"),
        "thumbnail": THUMB_URL.format(vid=vid),
        "source": "youtube",
        "live": bool(e.get("is_live")) or e.get("duration") is None,
    }


def search(query: str, limit: int = 20) -> list[dict]:
    """YouTube music-ish search. Flat extraction: one fast request."""
    limit = max(1, min(int(limit), 50))
    opts = _base_opts(extract_flat="in_playlist", playlist_items=f"1:{limit}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp raises a zoo of exceptions
        raise ResolveError(f"search failed: {exc}"[:200]) from exc
    out = []
    for e in (info or {}).get("entries") or []:
        if not e:
            continue
        t = _entry_to_track(e)
        if t:
            out.append(t)
    return out


def get_metadata(video_id: str) -> dict:
    """Full metadata for one video (no format resolution — single page fetch)."""
    if not is_video_id(video_id):
        raise TrackUnavailable(f"invalid video id: {video_id}")
    opts = _base_opts()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=False, process=False)
    except Exception as exc:  # noqa: BLE001
        raise _translate(exc, video_id) from exc
    if not info:
        raise TrackUnavailable(video_id)
    t = _entry_to_track(info)
    if not t:
        raise TrackUnavailable(video_id)
    t["description"] = (info.get("description") or "")[:500]
    t["view_count"] = info.get("view_count")
    t["upload_date"] = info.get("upload_date")
    return t


def resolve_stream(video_id: str, fmt: str = "auto") -> dict:
    """Return {url, headers, filesize, acodec, ext} for direct audio streaming."""
    fmt = fmt if fmt in _FORMATS else "auto"
    key = (video_id, fmt)
    now = time.time()
    with _cache_lock:
        hit = _url_cache.get(key)
        if hit and hit["expires"] > now + 60:
            return hit
    if not is_video_id(video_id):
        raise TrackUnavailable(f"invalid video id: {video_id}")
    opts = _base_opts(format=_FORMATS[fmt])
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=False)
    except Exception as exc:  # noqa: BLE001
        raise _translate(exc, video_id) from exc
    url = (info or {}).get("url")
    if not url:
        # chosen format had no progressive URL (rare) — retry with plain bestaudio
        opts = _base_opts(format="bestaudio/best")
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                        download=False)
        except Exception as exc:  # noqa: BLE001
            raise _translate(exc, video_id) from exc
        url = (info or {}).get("url")
    if not url:
        raise ResolveError(f"no stream url for {video_id}")
    entry = {
        "url": url,
        "headers": dict(info.get("http_headers") or {}),
        "filesize": info.get("filesize") or info.get("filesize_approx"),
        "acodec": info.get("acodec"),
        "ext": info.get("ext") or "m4a",
        "expires": time.time() + URL_CACHE_TTL,
    }
    with _cache_lock:
        _url_cache[key] = entry
    return entry


def invalidate(video_id: str) -> None:
    with _cache_lock:
        for key in [k for k in _url_cache if k[0] == video_id]:
            _url_cache.pop(key, None)


def related_mix(video_id: str, limit: int = 40) -> list[dict]:
    """YouTube's auto-generated 'Mix/Radio' playlist for a video — the
    recommendation graph, one request, no API key."""
    opts = _base_opts(extract_flat="in_playlist", playlist_items=f"1:{limit}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}",
                download=False)
    except Exception as exc:  # noqa: BLE001
        log.warning("mix for %s failed: %s", video_id, str(exc)[:120])
        return []
    out = []
    for e in (info or {}).get("entries") or []:
        if not e:
            continue
        t = _entry_to_track(e)
        if t and t["id"] != video_id:
            out.append(t)
    return out


def download_audio(video_id: str, dest_dir: Path,
                   progress_cb: Callable[[str, float, float | None], None] | None = None
                   ) -> Path:
    """Download best audio to dest_dir; returns the final file path.

    Prefers m4a (universally playable, easy tagging); falls back to whatever
    bestaudio gives (usually opus/webm). No transcoding — original container is
    kept, ffmpeg is only used if a remux is unavoidable.
    """
    if not is_video_id(video_id):
        raise TrackUnavailable(f"invalid video id: {video_id}")
    dest_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if progress_cb is None:
            return
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            progress_cb("downloading", done, total)
        elif status == "finished":
            progress_cb("processing", 1.0, 1.0)

    opts = _base_opts(
        format="bestaudio[ext=m4a]/bestaudio/best",
        skip_download=False,
        outtmpl=str(dest_dir / f"{video_id}.%(ext)s"),
        progress_hooks=[hook],
        noprogress=False,
        quiet=True,
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=True)
    except Exception as exc:  # noqa: BLE001
        raise _translate(exc, video_id) from exc

    requested = ((info or {}).get("requested_downloads") or [{}])[0]
    path = requested.get("filepath")
    if not path:
        # fall back to whatever landed in dest_dir
        matches = sorted(dest_dir.glob(f"{video_id}.*"), key=lambda p: p.stat().st_mtime)
        path = str(matches[-1]) if matches else None
    if not path or not Path(path).exists():
        raise ResolveError(f"download produced no file for {video_id}")
    return Path(path)


def fetch_thumbnail(video_id: str) -> bytes | None:
    """Best-effort cover bytes (hqdefault → mqdefault), for tagging/covers dir."""
    import httpx
    for name in ("maxresdefault", "hqdefault", "mqdefault"):
        try:
            r = httpx.get(f"https://i.ytimg.com/vi/{video_id}/{name}.jpg", timeout=10)
            if r.status_code == 200 and len(r.content) > 1000:
                return r.content
        except Exception:  # noqa: BLE001
            continue
    return None
