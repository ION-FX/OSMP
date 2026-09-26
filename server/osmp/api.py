"""HTTP API: search, Range-proxied streaming, offline library, playlists, radio, LLM."""
from __future__ import annotations

import asyncio
import logging
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import db, llm, radio, update, youtube
from .config import get_config

log = logging.getLogger("osmp.api")
router = APIRouter(prefix="/api")

CHUNK = 256 * 1024
MEDIA_TYPES = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm",
               ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg"}

# --------------------------------------------------------------- auth (optional PIN)

_sessions: set[str] = set()
_sessions_lock = threading.Lock()
_AUTH_EXEMPT = {"/api/health", "/api/config", "/api/auth", "/api/auth/logout"}


def _pin_set() -> bool:
    return bool((db.get_setting("access_pin") or "").strip())


def _authorized(session: str | None) -> bool:
    if not _pin_set():
        return True
    with _sessions_lock:
        return bool(session) and session in _sessions


class AuthIn(BaseModel):
    pin: str


@router.post("/auth")
def auth(body: AuthIn):
    expected = (db.get_setting("access_pin") or "").strip()
    if not expected:
        return {"ok": True, "auth_required": False}
    if not secrets.compare_digest(body.pin.strip(), expected):
        raise HTTPException(401, "Wrong PIN")
    token = secrets.token_hex(24)
    with _sessions_lock:
        _sessions.add(token)
    resp = JSONResponse({"ok": True, "auth_required": True})
    resp.set_cookie("osmp_session", token, httponly=True, samesite="lax",
                    max_age=30 * 24 * 3600)
    return resp


@router.post("/auth/logout")
def logout(request: Request):
    token = request.cookies.get("osmp_session")
    with _sessions_lock:
        _sessions.discard(token or "")
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("osmp_session")
    return resp


# --------------------------------------------------------------- meta

@router.get("/health")
def health():
    return {"ok": True, "time": time.time()}


@router.get("/config")
def client_config(request: Request):
    from . import __version__
    try:
        cinfo = update.current_info()
    except Exception:  # noqa: BLE001 — never break config on update introspection
        cinfo = {}
    return {
        "version": __version__,
        "commit": cinfo.get("commit"),
        "update_mode": cinfo.get("mode", "unknown"),
        "auth_required": _pin_set() and not _authorized(request.cookies.get("osmp_session")),
        "llm_configured": llm.is_configured(),
        "ffmpeg": bool(get_config().ffmpeg_path),
    }


# --------------------------------------------------------------- search / metadata

@router.get("/search")
def search(q: str, limit: int = 20):
    q = q.strip()
    if not q:
        return {"query": q, "results": []}
    try:
        results = youtube.search(q, limit)
    except youtube.TrackUnavailable as exc:
        raise HTTPException(404, str(exc))
    except youtube.ResolveError as exc:
        raise HTTPException(502, str(exc))
    # enrich with offline status
    for t in results:
        row = db.get_track(t["id"])
        t["offline"] = bool(row and row.get("file_path"))
    return {"query": q, "results": results}


@router.get("/track/{video_id}")
def track_meta(video_id: str):
    row = db.get_track(video_id)
    if row:
        return _track_out(row)
    try:
        t = youtube.get_metadata(video_id)
    except youtube.TrackUnavailable as exc:
        raise HTTPException(404, str(exc))
    except youtube.ResolveError as exc:
        raise HTTPException(502, str(exc))
    db.upsert_track(t)
    t["offline"] = False
    return t


class ResolveIn(BaseModel):
    ids: list[str] = Field(max_length=50)


@router.post("/resolve")
def resolve_batch(body: ResolveIn):
    out = {}
    for vid in body.ids:
        try:
            row = db.get_track(vid)
            out[vid] = _track_out(row) if row else track_meta(vid)
        except HTTPException as exc:
            out[vid] = {"error": exc.detail}
    return {"tracks": out}


def _track_out(row: dict) -> dict:
    t = {
        "id": row["id"], "title": row["title"], "artist": row["artist"],
        "duration": row["duration"], "thumbnail": row["thumbnail"],
        "source": row.get("source", "youtube"),
        "offline": bool(row.get("file_path")),
        "play_count": row.get("play_count", 0),
    }
    return t


# --------------------------------------------------------------- streaming proxy

async def _proxy_stream(request: Request, video_id: str, fmt: str, head_only: bool):
    client: httpx.AsyncClient = request.app.state.http
    last_status = 502
    for attempt in (0, 1):
        try:
            info = await run_in_threadpool(youtube.resolve_stream, video_id, fmt)
        except youtube.TrackUnavailable as exc:
            raise HTTPException(404, str(exc))
        except youtube.ResolveError as exc:
            raise HTTPException(502, str(exc))

        headers = dict(info.get("headers") or {})
        rng = request.headers.get("range")
        if rng:
            headers["Range"] = rng
        try:
            upstream_req = client.build_request("GET", info["url"], headers=headers)
            upstream = await client.send(upstream_req, stream=True)
        except httpx.HTTPError as exc:
            last_status = 502
            log.warning("upstream connect failed for %s: %s", video_id, exc)
            youtube.invalidate(video_id)
            if attempt == 0:
                continue
            raise HTTPException(502, f"upstream unreachable: {exc}"[:200])

        if upstream.status_code in (403, 410, 429):
            await upstream.aclose()
            last_status = upstream.status_code
            youtube.invalidate(video_id)
            if attempt == 0:
                continue
            raise HTTPException(502, f"upstream refused ({upstream.status_code})")
        if upstream.status_code >= 400:
            await upstream.aclose()
            raise HTTPException(502, f"upstream error {upstream.status_code}")

        ctype = upstream.headers.get("content-type", f"audio/{info.get('ext', 'mp4')}")
        out_headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
        for h in ("content-range", "content-length"):
            if h in upstream.headers:
                out_headers[h] = upstream.headers[h]

        if head_only:
            await upstream.aclose()
            return Response(status_code=upstream.status_code, headers=out_headers,
                            media_type=ctype)

        async def body():
            try:
                async for chunk in upstream.aiter_bytes(CHUNK):
                    yield chunk
            except (httpx.HTTPError, asyncio.CancelledError):
                pass  # client seeked away / network blip — normal for media streams
            finally:
                await upstream.aclose()

        return StreamingResponse(body(), status_code=upstream.status_code,
                                 headers=out_headers, media_type=ctype)
    raise HTTPException(last_status if last_status < 500 else 502, "stream failed")


@router.get("/stream/{video_id}")
async def stream(request: Request, video_id: str, fmt: str = "auto"):
    return await _proxy_stream(request, video_id, fmt, head_only=False)


@router.head("/stream/{video_id}")
async def stream_head(request: Request, video_id: str, fmt: str = "auto"):
    return await _proxy_stream(request, video_id, fmt, head_only=True)


# --------------------------------------------------------------- offline library

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


class DownloadIn(BaseModel):
    video_id: str
    title: str | None = None
    artist: str | None = None


def _tag_file(path: Path, meta: dict, cover: bytes | None) -> None:
    """Best-effort ID tagging; never fatal."""
    try:
        import mutagen
        from mutagen.mp4 import MP4, MP4Cover
        audio = mutagen.File(str(path))
        if audio is None:
            return
        if audio.tags is None:
            audio.add_tags()
        audio.tags["title"] = meta.get("title") or path.stem
        audio.tags["artist"] = meta.get("artist") or "Unknown"
        audio.tags["album"] = "OSMP Library"
        if cover:
            if isinstance(audio, MP4):
                audio.tags["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
            else:
                from mutagen.flac import Picture
                import base64
                pic = Picture()
                pic.type = 3  # front cover
                pic.mime = "image/jpeg"
                pic.data = cover
                audio.tags["metadata_block_picture"] = [
                    base64.b64encode(pic.write()).decode("ascii")]
        audio.save()
    except Exception as exc:  # noqa: BLE001
        log.info("tagging %s failed: %s", path.name, exc)


def _download_job(job_id: str, video_id: str, hint: DownloadIn):
    cfg = get_config()
    try:
        with _jobs_lock:
            _jobs[job_id].update(status="downloading", progress=0.0)

        def progress(status: str, done: float, total: float | None):
            frac = (done / total) if (total and status == "downloading") else 1.0
            with _jobs_lock:
                _jobs[job_id].update(status=status, progress=round(min(frac, 1.0), 3))

        path = youtube.download_audio(video_id, cfg.library_dir, progress_cb=progress)

        with _jobs_lock:
            _jobs[job_id].update(status="processing")

        meta = {"id": video_id}
        row = db.get_track(video_id)
        if row:
            meta.update(title=row["title"], artist=row["artist"])
        else:
            try:
                fetched = youtube.get_metadata(video_id)
                meta.update(title=fetched["title"], artist=fetched["artist"],
                            duration=fetched["duration"], thumbnail=fetched["thumbnail"])
                db.upsert_track(fetched)
            except youtube.YouTubeError:
                meta.update(title=hint.title or video_id, artist=hint.artist or "Unknown")
        if hint.title and not row:
            meta["title"] = hint.title
        if hint.artist and not row:
            meta["artist"] = hint.artist

        cover = youtube.fetch_thumbnail(video_id)
        if cover:
            cover_path = cfg.covers_dir / f"{video_id}.jpg"
            cover_path.write_bytes(cover)
        _tag_file(path, meta, cover)

        db.set_track_file(video_id, str(path), path.stat().st_size)
        db.upsert_track({**meta, "thumbnail": meta.get("thumbnail") or
                         youtube.THUMB_URL.format(vid=video_id)})
        db.set_track_file(video_id, str(path), path.stat().st_size)

        with _jobs_lock:
            _jobs[job_id].update(status="done", progress=1.0, track_id=video_id,
                                 file=str(path))
    except youtube.YouTubeError as exc:
        log.warning("download %s failed: %s", video_id, exc)
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(exc)[:300])
    except Exception as exc:  # noqa: BLE001
        log.exception("download %s crashed", video_id)
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(exc)[:300])


@router.post("/library/download")
def library_download(body: DownloadIn, request: Request):
    if not youtube.is_video_id(body.video_id):
        raise HTTPException(400, "invalid video_id")
    row = db.get_track(body.video_id)
    if row and row.get("file_path") and Path(row["file_path"]).exists():
        return {"job_id": None, "already": True, "track": _track_out(row)}
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"status": "queued", "progress": 0.0, "video_id": body.video_id,
                         "started": time.time()}
        # prune old finished jobs
        for old in [k for k, v in _jobs.items()
                    if v["status"] in ("done", "error") and time.time() - v.get("started", 0) > 3600]:
            _jobs.pop(old, None)
    threading.Thread(target=_download_job, args=(job_id, body.video_id, body),
                     daemon=True).start()
    return {"job_id": job_id, "already": False}


@router.get("/library/jobs/{job_id}")
def library_job(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job


@router.get("/library")
def library(offline_only: bool = False, limit: int = 500):
    rows = db.list_tracks(offline_only=offline_only, limit=limit)
    tracks = []
    for r in rows:
        t = _track_out(r)
        t["file_size"] = r.get("file_size")
        t["added_at"] = r.get("added_at")
        # stale file? report as not offline
        if r.get("file_path") and not Path(r["file_path"]).exists():
            t["offline"] = False
            db.set_track_file(r["id"], None, None)
        tracks.append(t)
    return {"tracks": tracks}


@router.delete("/library/{video_id}")
def library_delete(video_id: str):
    row = db.get_track(video_id)
    if not row or not row.get("file_path"):
        raise HTTPException(404, "not in library")
    try:
        Path(row["file_path"]).unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(500, f"delete failed: {exc}")
    db.set_track_file(video_id, None, None)
    cover = get_config().covers_dir / f"{video_id}.jpg"
    cover.unlink(missing_ok=True)
    return {"ok": True}


async def _local_file(request: Request, video_id: str, head_only: bool):
    row = db.get_track(video_id)
    if not row or not row.get("file_path"):
        raise HTTPException(404, "not in library")
    path = Path(row["file_path"])
    if not path.exists():
        db.set_track_file(video_id, None, None)
        raise HTTPException(404, "file missing")
    ctype = MEDIA_TYPES.get(path.suffix.lower(), "audio/mp4")
    if head_only:
        return Response(status_code=200, media_type=ctype, headers={
            "Accept-Ranges": "bytes", "Content-Length": str(path.stat().st_size)})
    return FileResponse(path, media_type=ctype, filename=path.name,
                        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store"})


@router.get("/library/stream/{video_id}")
async def library_stream(request: Request, video_id: str):
    return await _local_file(request, video_id, head_only=False)


@router.head("/library/stream/{video_id}")
async def library_stream_head(request: Request, video_id: str):
    return await _local_file(request, video_id, head_only=True)


# --------------------------------------------------------------- playlists

class PlaylistIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    kind: Literal["user", "radio"] = "user"


class PlaylistPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=500)


class TrackIn(BaseModel):
    id: str
    title: str | None = None
    artist: str | None = None
    duration: float | None = None
    thumbnail: str | None = None


class TracksIn(BaseModel):
    tracks: list[TrackIn] = Field(min_length=1, max_length=500)


class ReorderIn(BaseModel):
    order: list[str] = Field(min_length=1, max_length=1000)


@router.get("/playlists")
def playlists_list():
    return {"playlists": db.list_playlists()}


@router.post("/playlists")
def playlists_create(body: PlaylistIn):
    pid = db.create_playlist(body.name, body.description, body.kind)
    pl = db.get_playlist(pid)
    return pl


@router.get("/playlists/{playlist_id}")
def playlists_get(playlist_id: int):
    pl = db.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(404, "playlist not found")
    pl["tracks"] = [_track_out(t) for t in pl["tracks"]]
    return pl


@router.patch("/playlists/{playlist_id}")
def playlists_patch(playlist_id: int, body: PlaylistPatch):
    if not db.get_playlist(playlist_id):
        raise HTTPException(404, "playlist not found")
    db.update_playlist(playlist_id, body.name, body.description)
    return db.get_playlist(playlist_id)


@router.delete("/playlists/{playlist_id}")
def playlists_delete(playlist_id: int):
    if not db.delete_playlist(playlist_id):
        raise HTTPException(404, "playlist not found")
    return {"ok": True}


def _enrich(tracks: list[TrackIn]) -> list[dict]:
    """Fill in missing metadata from cache/YouTube without failing the request."""
    out = []
    for t in tracks:
        if not youtube.is_video_id(t.id):
            continue
        d = t.model_dump(exclude_none=True)
        if not d.get("title"):
            row = db.get_track(t.id)
            if row:
                d.update(title=row["title"], artist=row["artist"],
                         duration=row["duration"], thumbnail=row["thumbnail"])
            else:
                try:
                    meta = youtube.get_metadata(t.id)
                    d.update(title=meta["title"], artist=meta["artist"],
                             duration=meta["duration"], thumbnail=meta["thumbnail"])
                except youtube.YouTubeError:
                    d.setdefault("title", t.id)
        d.setdefault("thumbnail", youtube.THUMB_URL.format(vid=t.id))
        out.append(d)
    return out


@router.post("/playlists/{playlist_id}/tracks")
def playlists_add(playlist_id: int, body: TracksIn):
    if not db.get_playlist(playlist_id):
        raise HTTPException(404, "playlist not found")
    tracks = _enrich(body.tracks)
    if not tracks:
        raise HTTPException(400, "no valid tracks")
    added = db.playlist_add_tracks(playlist_id, tracks)
    return {"ok": True, "added": added}


@router.delete("/playlists/{playlist_id}/tracks/{track_id}")
def playlists_remove(playlist_id: int, track_id: str):
    if not db.playlist_remove_track(playlist_id, track_id):
        raise HTTPException(404, "track not in playlist")
    return {"ok": True}


@router.put("/playlists/{playlist_id}/tracks")
def playlists_reorder(playlist_id: int, body: ReorderIn):
    if not db.get_playlist(playlist_id):
        raise HTTPException(404, "playlist not found")
    db.playlist_reorder(playlist_id, body.order)
    return {"ok": True}


# --------------------------------------------------------------- radio / LLM

@router.get("/radio/generate")
def radio_generate(seed: str, count: int = 25):
    try:
        return radio.generate(seed, count)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except youtube.TrackUnavailable as exc:
        raise HTTPException(404, str(exc))
    except youtube.ResolveError as exc:
        raise HTTPException(502, str(exc))


class LLMPromptIn(BaseModel):
    prompt: str = Field(min_length=2, max_length=500)
    count: int = 20


# --------------------------------------------------------------- self-update

@router.post("/update/check")
def update_check():
    try:
        return update.check()
    except update.UpdateError as exc:
        raise HTTPException(502, str(exc))


class UpdateApplyIn(BaseModel):
    kind: Literal["full", "ytdlp"] = "full"


@router.post("/update/apply")
def update_apply(body: UpdateApplyIn):
    try:
        return update.start_job(body.kind)
    except update.UpdateError as exc:
        raise HTTPException(400, str(exc))


@router.get("/update/status/{job_id}")
def update_status(job_id: str):
    try:
        return update.job_status(job_id)
    except update.UpdateError as exc:
        raise HTTPException(404, str(exc))


@router.post("/radio/llm")
def radio_llm(body: LLMPromptIn):
    try:
        return llm.curate(body.prompt, body.count)
    except llm.LLMNotConfigured as exc:
        raise HTTPException(428, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except llm.LLMError as exc:
        raise HTTPException(502, str(exc))


# --------------------------------------------------------------- settings / history

_SENSITIVE = {"llm_api_key", "access_pin", "github_token"}
_ALLOWED_SETTINGS = {"llm_base_url", "llm_api_key", "llm_model", "access_pin",
                     "default_format", "radio_count", "github_token"}


@router.get("/settings")
def settings_get():
    s = db.all_settings()
    out = {}
    for k, v in s.items():
        if k in _SENSITIVE:
            out[k] = "***set***" if v else ""
        else:
            out[k] = v
    out["llm_configured"] = llm.is_configured()
    return out


@router.put("/settings")
def settings_put(body: dict):
    changed = []
    for k, v in body.items():
        if k not in _ALLOWED_SETTINGS:
            continue
        if k in _SENSITIVE and v == "***set***":
            continue  # masked value echoed back — leave as is
        if k == "access_pin":
            v = str(v or "").strip()
            with _sessions_lock:
                _sessions.clear()
        db.set_setting(k, v)
        changed.append(k)
    return {"ok": True, "changed": changed}


class HistoryIn(BaseModel):
    track_id: str


@router.post("/history")
def history_record(body: HistoryIn):
    db.record_play(body.track_id)
    return {"ok": True}


@router.get("/home")
def home():
    recent = [_track_out(t) for t in db.recent_history(12)]
    offline = [_track_out(t) for t in db.list_tracks(offline_only=True, limit=8)]
    playlists = db.list_playlists()[:8]
    stats = {
        "library_tracks": len(db.list_tracks(offline_only=True, limit=10000)),
        "playlists": len(db.list_playlists()),
    }
    return {"recent": recent, "downloads": offline, "playlists": playlists, "stats": stats}
