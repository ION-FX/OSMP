"""HTTP API: search, Range-proxied streaming, offline library, playlists, radio, LLM."""
from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Cookie, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import auth, db, llm, lyrics, radio, update, upload, youtube
from .config import get_config

log = logging.getLogger("osmp.api")
router = APIRouter(prefix="/api")

CHUNK = 256 * 1024
MEDIA_TYPES = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm",
               ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg"}

# --------------------------------------------------------------- auth (accounts)

_AUTH_EXEMPT = {"/api/health", "/api/config", "/api/auth/login", "/api/auth/logout",
                "/api/auth/me", "/api/setup"}


class LoginIn(BaseModel):
    username: str
    password: str


class SetupIn(BaseModel):
    username: str
    password: str
    name: str | None = None  # optional friendly server name


class PasswordIn(BaseModel):
    password: str


class UserIn(BaseModel):
    username: str
    password: str
    role: Literal["admin", "user"] = "user"


def _token_from(request: Request) -> str | None:
    bearer = request.headers.get("authorization", "")
    if bearer.lower().startswith("bearer "):
        return bearer[7:].strip()
    return request.cookies.get(auth.COOKIE)


def current_user(request: Request) -> dict | None:
    try:
        return auth.session_user(_token_from(request))
    except Exception:  # noqa: BLE001 — auth must never 500
        return None


def require_user(request: Request) -> dict:
    user = current_user(request)
    if not user:
        raise HTTPException(401, "authentication required")
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if user["role"] != "admin":
        raise HTTPException(403, "admin account required")
    return user


def _pub_user(u: dict) -> dict:
    return {"id": u["id"], "name": u["username"], "role": u["role"]}


def _session_response(user: dict) -> JSONResponse:
    """Login/setup answer: cookie for browsers + bearer token for native clients."""
    token = auth.create_session(user["id"])
    resp = JSONResponse({"ok": True, "token": token, "user": _pub_user(user)})
    resp.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax",
                    max_age=auth.SESSION_TTL, path="/")
    return resp


@router.post("/setup")
def setup(body: SetupIn):
    """Create the first (admin) account. Refuses once any user exists."""
    if not auth.setup_required():
        raise HTTPException(403, "this server already has an admin account")
    try:
        user = auth.create_user(body.username, body.password, role="admin")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if (body.name or "").strip():
        db.set_setting("server_name", body.name.strip()[:60])
    db.set_setting("access_pin", "")  # PIN auth is retired by accounts
    return _session_response(user)


@router.post("/auth/login")
def auth_login(body: LoginIn):
    u = auth.find_user(body.username)
    if not u or not u["active"] or not auth.verify_password(body.password, u["pwhash"]):
        raise HTTPException(401, "Wrong username or password")
    return _session_response(u)


@router.post("/auth/logout")
def auth_logout(request: Request):
    auth.drop_session(_token_from(request))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@router.get("/auth/me")
def auth_me(request: Request):
    user = require_user(request)
    return {"user": _pub_user(user)}


# --------------------------------------------------------------- user admin

@router.get("/users")
def users_list(request: Request):
    require_admin(request)
    return {"users": [{**u, "pwhash": None} for u in auth.list_users()]}


@router.post("/users")
def users_create(request: Request, body: UserIn):
    require_admin(request)
    try:
        u = auth.create_user(body.username, body.password, role=body.role)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"user": _pub_user(u)}


@router.delete("/users/{user_id}")
def users_delete(request: Request, user_id: int):
    admin = require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(400, "you cannot delete your own account")
    try:
        auth.delete_user(user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@router.post("/users/{user_id}/password")
def users_password(request: Request, user_id: int, body: PasswordIn):
    user = require_user(request)
    if user["role"] != "admin" and user["id"] != user_id:
        raise HTTPException(403, "you can only change your own password")
    target = auth.get_user(user_id)
    if not target:
        raise HTTPException(404, "no such user")
    try:
        auth.set_password(user_id, body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if user["role"] != "admin" or user_id == user["id"]:
        auth.drop_session(_token_from(request))  # re-login after self password change
    return {"ok": True}


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
    user = current_user(request)
    return {
        "version": __version__,
        "commit": cinfo.get("commit"),
        "update_mode": cinfo.get("mode", "unknown"),
        "auth_required": auth.setup_required() or user is None,
        "setup_required": auth.setup_required(),
        "server_name": db.get_setting("server_name", "") or "",
        "user": _pub_user(user) if user else None,
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


# --------------------------------------------------------------- playlist import

_imports: dict[str, dict] = {}
_imports_lock = threading.Lock()
_IMPORT_TTL = 30 * 60


class ImportPreviewIn(BaseModel):
    url: str


class ImportApplyIn(BaseModel):
    preview_id: str
    name: str | None = None
    track_ids: list[str] | None = None


def _prune_imports() -> None:
    now = time.time()
    for k in [k for k, v in _imports.items() if now - v["created"] > _IMPORT_TTL]:
        _imports.pop(k, None)
    if len(_imports) > 20:
        oldest = sorted(_imports, key=lambda k: _imports[k]["created"])[:len(_imports) - 20]
        for k in oldest:
            _imports.pop(k, None)


@router.post("/import/preview")
def import_preview(body: ImportPreviewIn):
    src = youtube.import_source(body.url)
    if src is None:
        raise HTTPException(400, "Not a YouTube playlist, album, or channel link")
    kind, url = src
    if kind == "mix":
        raise HTTPException(400, "YouTube mixes are endless — use Radio for those")
    try:
        pl = youtube.fetch_playlist(url)
    except youtube.TrackUnavailable as exc:
        raise HTTPException(404, str(exc))
    except youtube.ResolveError as exc:
        raise HTTPException(502, str(exc))
    if not pl["items"]:
        raise HTTPException(404, "No playable tracks found in that source")
    preview_id = uuid.uuid4().hex[:12]
    pl.update(kind=kind, created=time.time())
    with _imports_lock:
        _prune_imports()
        _imports[preview_id] = pl
    return {
        "preview_id": preview_id, "kind": kind, "title": pl["title"],
        "uploader": pl["uploader"], "thumbnail": pl["thumbnail"],
        "total_duration": pl["total_duration"], "truncated": pl["truncated"],
        "items": [_track_out(t) for t in pl["items"]],
    }


@router.post("/import/apply")
def import_apply(body: ImportApplyIn):
    with _imports_lock:
        pl = _imports.get(body.preview_id)
    if not pl or time.time() - pl["created"] > _IMPORT_TTL:
        raise HTTPException(404, "Preview expired — load the playlist again")
    items = pl["items"]
    if body.track_ids is not None:  # client may import a subset; ids outside the preview are ignored
        by_id = {t["id"]: t for t in items}
        items = [by_id[i] for i in dict.fromkeys(body.track_ids) if i in by_id]
        if not items:
            raise HTTPException(400, "No tracks selected")
    pid = db.create_playlist(body.name or pl["title"] or "Imported playlist")
    added = db.playlist_add_tracks(pid, items)
    return {"playlist_id": pid, "added": added, "total": len(pl["items"])}


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
        # googlevideo stalls plain full GETs without a Range header — always
        # send one; a Range-less client gets the 206 rewritten to 200 below
        headers["Range"] = rng if rng else "bytes=0-"
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
        if rng is None:
            out_headers.pop("content-range", None)  # we asked for the whole file

        if head_only:
            await upstream.aclose()
            status = upstream.status_code if rng else (200 if upstream.status_code == 206 else upstream.status_code)
            return Response(status_code=status, headers=out_headers, media_type=ctype)

        async def body():
            try:
                async for chunk in upstream.aiter_bytes(CHUNK):
                    yield chunk
            except (httpx.HTTPError, asyncio.CancelledError):
                pass  # client seeked away / network blip — normal for media streams
            finally:
                await upstream.aclose()

        return StreamingResponse(body(),
                                 status_code=upstream.status_code if rng else 200,
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
    cover = get_config().covers_dir / f"{video_id}.jpg"
    cover.unlink(missing_ok=True)
    if row.get("source") == "local":
        # an upload has no YouTube existence to keep — remove the track itself
        db.delete_track(video_id)
        return {"ok": True, "removed": "track"}
    db.set_track_file(video_id, None, None)
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
def update_check(request: Request):
    require_admin(request)
    try:
        return update.check()
    except update.UpdateError as exc:
        raise HTTPException(502, str(exc))


class UpdateApplyIn(BaseModel):
    kind: Literal["full", "ytdlp"] = "full"


@router.post("/update/apply")
def update_apply(request: Request, body: UpdateApplyIn):
    require_admin(request)
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
def settings_put(request: Request, body: dict):
    require_admin(request)
    changed = []
    for k, v in body.items():
        if k not in _ALLOWED_SETTINGS:
            continue
        if k in _SENSITIVE and v == "***set***":
            continue  # masked value echoed back — leave as is
        db.set_setting(k, v)
        changed.append(k)
    return {"ok": True, "changed": changed}


class HistoryIn(BaseModel):
    track_id: str


@router.post("/history")
def history_record(request: Request, body: HistoryIn):
    user = require_user(request)
    db.record_play(body.track_id, user_id=str(user["id"]))
    return {"ok": True}


@router.get("/home")
def home(request: Request):
    user = current_user(request)
    uid = str(user["id"]) if user else "local"
    recent = [_track_out(t) for t in db.recent_history(12, user_id=uid)]
    offline = [_track_out(t) for t in db.list_tracks(offline_only=True, limit=8)]
    playlists = db.list_playlists()[:8]
    stats = {
        "library_tracks": len(db.list_tracks(offline_only=True, limit=10000)),
        "playlists": len(db.list_playlists()),
    }
    return {"recent": recent, "downloads": offline, "playlists": playlists, "stats": stats}


# --------------------------------------------------------------- lyrics

@router.get("/lyrics/{video_id}")
def lyrics_for(video_id: str):
    row = db.get_track(video_id)
    if row:
        track = dict(row)
    else:
        try:
            track = youtube.get_metadata(video_id)
        except youtube.TrackUnavailable as exc:
            raise HTTPException(404, str(exc))
        except youtube.ResolveError as exc:
            raise HTTPException(502, str(exc))
    return lyrics.get_lyrics(track)


# --------------------------------------------------------------- stats

@router.get("/stats")
def stats(request: Request, days: int = 30, scope: str = "me"):
    days = max(1, min(days, 365))
    user = require_user(request)
    uid = None if (scope == "all" and user["role"] == "admin") else str(user["id"])
    out = db.stats_summary(days, user_id=uid)
    out["by_day"] = db.stats_by_day(days, user_id=uid)
    out["by_hour"] = db.stats_by_hour(user_id=uid)
    out["scope"] = "all" if uid is None else "me"
    return out


@router.get("/history/log")
def history_log_view(request: Request, limit: int = 200):
    user = require_user(request)
    limit = max(1, min(limit, 1000))
    out = []
    for t in db.history_log(limit, user_id=str(user["id"])):
        row = _track_out(t)
        row["played_at"] = t["played_at"]
        out.append(row)
    return {"plays": out}


@router.get("/mixes")
def mixes(request: Request):
    """"Made for you" shelf. Cheap on purpose (SQLite only) — the actual mix
    is generated on click through the existing radio endpoint."""
    user = current_user(request)
    uid = str(user["id"]) if user else "local"
    summary = db.stats_summary(90, user_id=uid)
    cards = [{"id": f"artist:{a['artist']}",
              "kind": "artist",
              "title": f"More like {a['artist']}",
              "subtitle": f"{a['plays']} plays · {a['tracks']} tracks",
              "seed": a["artist"]}
             for a in summary["top_artists"] if a["plays"] >= 2][:5]
    recent = db.recent_history(6, user_id=uid)
    fresh = [t for t in db.list_tracks(offline_only=True, limit=500)
             if not (t.get("play_count") or 0)][:8]
    return {"mixes": cards,
            "jump_back_in": [_track_out(t) for t in recent],
            "fresh": [_track_out(t) for t in fresh]}


# --------------------------------------------------------------- artists

@router.get("/artist")
def artist_page(name: str, request: Request):
    """Everything the artist view needs: library tracks + play stats."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "artist name required")
    user = current_user(request)
    uid = str(user["id"]) if user else "local"
    tracks = [_track_out(t) for t in db.tracks_by_artist(name)]
    stats = db.artist_play_stats(name, user_id=uid)
    return {
        "artist": name,
        "tracks": tracks,
        "total_duration": sum(t.get("duration") or 0 for t in tracks),
        "plays": stats["plays"],
        "seconds": stats["seconds"],
        "last_played": stats["last_played"],
    }


@router.get("/artists")
def artists_list(q: str = "", limit: int = 60):
    rows = db.list_artists(limit=min(max(limit, 1), 200))
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in (r["artist"] or "").lower()]
    return {"artists": rows}


# --------------------------------------------------------------- uploads

@router.post("/upload")
async def upload_music(request: Request, file: UploadFile):
    """One audio file in, one first-class library track out (multipart)."""
    require_user(request)
    cfg = get_config()
    name = file.filename or "upload"
    ext = Path(name).suffix.lower()
    if ext not in upload.AUDIO_EXTS:
        raise HTTPException(400, f"unsupported file type: {ext or '(none)'} — "
                                 f"try {', '.join(sorted(upload.AUDIO_EXTS))}")
    tmp = cfg.library_dir / f".up-{uuid.uuid4().hex[:10]}{ext}"
    size = 0
    try:
        with tmp.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > upload.MAX_FILE_BYTES:
                    raise HTTPException(413, "file too large (400 MB limit)")
                out.write(chunk)
        track = await run_in_threadpool(upload.import_file, tmp, cfg)
    except FileExistsError:
        raise HTTPException(409, "already in your library")
    except ValueError as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, str(exc))
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    return {"ok": True, "track": _track_out(track)}


class ScanIn(BaseModel):
    path: str


@router.post("/upload/scan")
def upload_scan(body: ScanIn, request: Request):
    """Import every audio file under a server-side directory (copies only)."""
    require_admin(request)
    try:
        # sync def → FastAPI already runs this in its threadpool
        return upload.scan_directory(body.path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/art/{track_id}")
def track_art(track_id: str):
    """Cover art extracted at upload time (embedded tag image)."""
    art = get_config().covers_dir / f"{track_id}.jpg"
    if not art.is_file():
        raise HTTPException(404, "no art")
    return FileResponse(art, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=604800"})


# --------------------------------------------------------------- backup

@router.get("/backup")
def backup_export(request: Request):
    from . import __version__
    require_admin(request)
    data = db.export_library()
    data["format"] = "osmp-backup"
    data["version"] = __version__
    data["exported_at"] = time.time()
    fname = time.strftime("osmp-backup-%Y%m%d-%H%M.json")
    return JSONResponse(data, headers={
        "Content-Disposition": f'attachment; filename="{fname}"'})


class RestoreIn(BaseModel):
    data: dict


@router.post("/backup/restore")
def backup_restore(request: Request, body: RestoreIn):
    require_admin(request)
    data = body.data or {}
    if data.get("format") not in (None, "osmp-backup"):
        raise HTTPException(400, "Not an OSMP backup file")
    try:
        result = db.import_library(data)
    except Exception as exc:  # noqa: BLE001 — shape errors become 400s
        raise HTTPException(400, f"Backup is malformed: {exc}")
    return {"ok": True, **result}
