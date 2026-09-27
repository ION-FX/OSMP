"""FastAPI application assembly: middleware, API router, static web UI."""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db, youtube
from .api import _AUTH_EXEMPT, current_user, router
from .config import Config, get_config, set_config

log = logging.getLogger("osmp")


def find_webui() -> Path:
    env = os.environ.get("OSMP_WEBUI")
    meipass = getattr(sys, "_MEIPASS", "")
    candidates = [
        Path(env) if env else None,
        Path(meipass) / "webui" if meipass else None,      # PyInstaller bundle
        Path(__file__).resolve().parents[1] / "webui",     # frozen _internal/webui
        Path(__file__).resolve().parents[2] / "webui",     # repo: OSMP/webui
        Path(sys_executable_dir()) / "webui",
    ]
    for c in candidates:
        if c and (c / "index.html").is_file():
            return c
    raise RuntimeError(f"web UI not found (looked for index.html); set OSMP_WEBUI")


def sys_executable_dir() -> str:
    import sys
    return str(Path(sys.executable).parent)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db(get_config())
    try:
        auth.purge_expired()
    except Exception:  # noqa: BLE001 — housekeeping, never fatal
        pass
    app.state.http = httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(30.0, read=120.0, write=30.0, pool=30.0),
        limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) OSMP/0.1"},
    )
    cfg = get_config()
    log.info("OSMP ready | data=%s ffmpeg=%s", cfg.data_dir, cfg.ffmpeg_path or "MISSING")
    yield
    await app.state.http.aclose()


def create_app(data_dir: str | None = None) -> FastAPI:
    if data_dir:
        set_config(Config(data_dir))

    app = FastAPI(title="OSMP", docs_url="/api/docs", openapi_url="/api/openapi.json",
                  lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api") and path not in _AUTH_EXEMPT:
            if current_user(request) is None:
                # before the first admin exists, only /api/setup may mutate;
                # everything else stays locked so a LAN server isn't usable
                # until its owner claims it
                return JSONResponse({"detail": "authentication required"}, status_code=401)
        return await call_next(request)

    app.include_router(router)

    @app.exception_handler(youtube.TrackUnavailable)
    async def _unavailable(request: Request, exc: youtube.TrackUnavailable):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(youtube.ResolveError)
    async def _resolve(request: Request, exc: youtube.ResolveError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    webui = find_webui()
    app.mount("/", StaticFiles(directory=str(webui), html=True), name="ui")
    return app


app = create_app()
