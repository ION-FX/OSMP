"""OSMP self-update: check GitHub, apply, restart — one press.

Modes (auto-detected):
- source    repo checkout: git fetch/reset to origin/main, pip install
            -r requirements.txt, relaunch run.py with the same host/port/data.
- appimage  download the new release asset next to the running AppImage
            (APPIMAGE env from the type-2 runtime), swap it in, relaunch.
- unknown   report manual instructions.

The repo is private: a GitHub token (Settings -> Updates) is required for
check/apply unless the machine has its own git credentials. The token is
stored server-side only and never leaves this process except to GitHub.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx

from . import __version__, db
from .config import get_config

REPO = "ION-FX/OSMP"
RELEASE_URL = f"https://github.com/{REPO}/releases"
_API = f"https://api.github.com/repos/{REPO}"

JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()


class UpdateError(Exception):
    pass


# ── environment ──────────────────────────────────────────────────────

def appimage_path() -> str | None:
    return os.environ.get("APPIMAGE")


def is_frozen() -> bool:
    return getattr(sys, "frozen", False) or bool(appimage_path())


def repo_root() -> Path | None:
    p = Path(__file__).resolve().parents[2]
    return p if (p / ".git").exists() else None


def _token() -> str:
    return (db.get_setting("github_token") or "").strip()


def _gh_headers() -> dict:
    h = {"Accept": "application/vnd.github+json"}
    if _token():
        h["Authorization"] = f"Bearer {_token()}"
    return h


def current_info() -> dict:
    root = repo_root()
    info = {"mode": "unknown", "version": __version__, "commit": None,
            "dirty": False, "appimage": appimage_path()}
    if root and not is_frozen():
        info["mode"] = "source"
        info["root"] = str(root)
        r = _git(["rev-parse", "--short", "HEAD"], cwd=root)
        if r.returncode == 0:
            info["commit"] = r.stdout.strip()
        r = _git(["status", "--porcelain"], cwd=root)
        if r.returncode == 0:
            info["dirty"] = bool(r.stdout.strip())
    elif is_frozen():
        info["mode"] = "appimage"
    return info


# ── subprocess helpers ───────────────────────────────────────────────

def _git(args: list[str], token: str | None = None, cwd: Path | None = None
         ) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    cmd = ["git"]
    if token:
        # GitHub's git endpoints answer Bearer headers with a 401 challenge —
        # they want Basic auth. Feed the token through an inline credential
        # helper reading it from the child's env (never on the command line).
        env["OSMP_UPDATE_TOKEN"] = token
        helper = ("!f() { echo 'username=x-access-token'; "
                  "echo \"password=$OSMP_UPDATE_TOKEN\"; }; f")
        cmd += ["-c", "credential.helper=", "-c", f"credential.helper={helper}"]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=180,
                          cwd=cwd, env=env)


def _pip(args: list[str], log) -> bool:
    """pip install … with PEP-668 fallbacks (Ubuntu blocks plain user pip)."""
    base = [sys.executable, "-m", "pip", "install"]
    for extra in ([], ["--user"], ["--break-system-packages"],
                  ["--user", "--break-system-packages"]):
        r = subprocess.run(base + extra + args, capture_output=True,
                           text=True, timeout=600)
        if r.returncode == 0:
            tail = [ln for ln in (r.stdout or "").strip().splitlines() if ln][-4:]
            for ln in tail:
                log(ln)
            return True
        err = (r.stderr or "").strip().splitlines()
        log(f"pip retry ({' '.join(extra) or 'default'}): "
            f"{err[-1][:160] if err else 'failed'}")
    return False


# ── GitHub ───────────────────────────────────────────────────────────

def _latest_release() -> dict:
    try:
        r = httpx.get(f"{_API}/releases/latest", headers=_gh_headers(),
                      timeout=20, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise UpdateError(f"GitHub unreachable: {exc}") from exc
    if r.status_code == 404:
        raise UpdateError(
            "Repository is private and no GitHub token is configured. "
            "Paste a token in Settings → Updates (it stays on your server).")
    if r.status_code == 401:
        raise UpdateError("GitHub token rejected (401) — check it in Settings → Updates.")
    if r.status_code != 200:
        raise UpdateError(f"GitHub API error {r.status_code}")
    d = r.json()
    return {"tag": d.get("tag_name", ""),
            "name": d.get("name", ""),
            "notes": (d.get("body") or "")[:800],
            "url": d.get("html_url") or RELEASE_URL,
            "assets": d.get("assets") or []}


def _remote_main_sha(root: Path, token: str | None) -> str | None:
    r = _git(["ls-remote", "origin", "main"], token=token, cwd=root)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return r.stdout.split()[0]


def _semver(s: str) -> tuple:
    m = re.findall(r"\d+", s or "")
    return tuple(int(x) for x in m[:4]) if m else (0,)


def check() -> dict:
    """Cheap: 1-2 GitHub calls + one ls-remote. Safe to call often."""
    info = current_info()
    rel = _latest_release()
    latest_v = rel["tag"].lstrip("v")
    out = {
        "mode": info["mode"],
        "current_version": __version__,
        "current_commit": info["commit"],
        "latest_tag": rel["tag"],
        "latest_version": latest_v,
        "latest_name": rel["name"],
        "notes": rel["notes"],
        "url": rel["url"],
        "update_available": False,
        "reason": None,
    }
    if info["mode"] == "source" and info["commit"]:
        token = _token()
        remote = _remote_main_sha(Path(info["root"]), token)
        if remote:
            r = _git(["rev-parse", "HEAD"], cwd=info["root"])
            local_full = r.stdout.strip() if r.returncode == 0 else ""
            out["remote_commit"] = remote[:7]
            if local_full and remote != local_full:
                out["update_available"] = True
                out["reason"] = "new commits on origin/main"
                return out
        # fall through to release comparison
    if _semver(latest_v) > _semver(__version__):
        out["update_available"] = True
        out["reason"] = f"release {rel['tag']} is newer than {__version__}"
    return out


# ── jobs ─────────────────────────────────────────────────────────────

def _new_job(kind: str) -> tuple[str, dict]:
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "running", "phase": "starting", "kind": kind,
           "lines": [], "started": time.time()}
    with _LOCK:
        for old in [k for k, v in JOBS.items()
                    if v["status"] in ("done", "error")
                    and time.time() - v["started"] > 3600]:
            JOBS.pop(old, None)
        JOBS[job_id] = job
    return job_id, job


def _log(job: dict, line: str) -> None:
    job["lines"].append(str(line)[:300])
    del job["lines"][:-200]


def start_job(kind: str = "full") -> dict:
    if kind not in ("full", "ytdlp"):
        raise UpdateError("unknown update kind")
    job_id, job = _new_job(kind)
    threading.Thread(target=_run_job, args=(job_id, job, kind), daemon=True).start()
    return {"job_id": job_id}


def job_status(job_id: str) -> dict:
    with _LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise UpdateError("unknown update job")
    return {"status": job["status"], "phase": job["phase"], "kind": job["kind"],
            "lines": job["lines"][-60:]}


def _run_job(job_id: str, job: dict, kind: str) -> None:
    try:
        info = current_info()
        if kind == "ytdlp":
            _ytdlp_job(job)
        elif info["mode"] == "appimage":
            _appimage_job(job)
        elif info["mode"] == "source":
            _source_job(job, info)
        else:
            raise UpdateError(
                "This install doesn't support self-update (no git repo, not an "
                "AppImage). Update manually from " + RELEASE_URL)
    except UpdateError as exc:
        job["status"] = "error"
        job["phase"] = "error"
        _log(job, f"✗ {exc}")
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["phase"] = "error"
        _log(job, f"✗ update crashed: {exc}")


# ── source-mode apply ────────────────────────────────────────────────

def _source_job(job: dict, info: dict) -> None:
    root = Path(info["root"])
    token = _token()
    job["phase"] = "fetching"

    rel = _latest_release()
    _log(job, f"latest release: {rel['tag']} — {rel['name'] or 'OSMP'}")

    if info["dirty"]:
        r = _git(["stash", "push", "-u", "-m", "osmp auto-update"], cwd=root)
        _log(job, "local changes stashed" if "saved" in (r.stdout or "")
             else "nothing to stash")
    else:
        _log(job, "working tree clean")

    _log(job, "fetching origin/main…")
    r = _git(["fetch", "origin", "main"], token=token, cwd=root)
    if r.returncode != 0:
        hint = "auth failed — set a GitHub token in Settings → Updates" \
            if "403" in (r.stderr or "") or "Authentication" in (r.stderr or "") \
            else (r.stderr or "fetch failed")[:200]
        raise UpdateError(f"git fetch failed: {hint}")
    _log(job, "fetch OK")

    r = _git(["rev-parse", "origin/main"], cwd=root)
    remote = r.stdout.strip()[:7] if r.returncode == 0 else "?"
    r = _git(["rev-parse", "HEAD"], cwd=root)
    local = r.stdout.strip()[:7] if r.returncode == 0 else "?"
    if remote == local and kind == "full":
        _log(job, f"already at origin/main ({local}) — refreshing deps only")

    job["phase"] = "installing"
    _log(job, f"updating code: {local} → {remote}")
    r = _git(["reset", "--hard", "origin/main"], cwd=root)
    if r.returncode != 0:
        raise UpdateError("git reset failed: " + (r.stderr or "")[:200])
    _log(job, f"code now at {r.stdout.strip()[:7]}")

    _log(job, "installing python dependencies…")
    if not _pip(["-r", str(root / "server" / "requirements.txt")],
                lambda l: _log(job, l)):
        _log(job, "⚠ pip failed — continuing with existing deps")

    _ytdlp_only(job, log_only=True)

    _log(job, "restarting OSMP…")
    _restart(job)


# ── yt-dlp quick update ──────────────────────────────────────────────

def _ytdlp_version() -> str:
    r = subprocess.run(
        [sys.executable, "-c", "import yt_dlp;print(yt_dlp.version.__version__)"],
        capture_output=True, text=True, timeout=60)
    return r.stdout.strip() if r.returncode == 0 else "?"


def _ytdlp_only(job: dict, log_only: bool = False) -> None:
    before = _ytdlp_version()
    job["phase"] = "yt-dlp"
    _log(job, f"updating yt-dlp (currently {before})…")
    if not _pip(["--upgrade", "yt-dlp"], lambda l: _log(job, l)):
        if log_only:
            _log(job, "⚠ yt-dlp upgrade failed — continuing")
            return
        raise UpdateError("yt-dlp upgrade failed")
    after = _ytdlp_version()
    _log(job, f"yt-dlp: {before} → {after}" + (" (unchanged)" if after == before else ""))
    if not log_only:
        _log(job, "restarting so the new extractor takes effect…")
        _restart(job)


def _ytdlp_job(job: dict) -> None:
    _ytdlp_only(job)


# ── appimage-mode apply ──────────────────────────────────────────────

def _appimage_job(job: dict) -> None:
    path = appimage_path()
    if not path or not Path(path).exists():
        raise UpdateError("APPIMAGE environment not set — cannot self-replace")
    rel = _latest_release()
    asset = None
    for a in rel["assets"]:
        if a.get("name", "").endswith("x86_64.AppImage"):
            asset = a
            break
    if not asset:
        raise UpdateError("no Linux AppImage asset on the latest release")
    _log(job, f"downloading {asset['name']} ({asset['size'] / 1e6:.0f} MB)…")
    job["phase"] = "downloading"
    tmp = Path(path + ".update")
    size = asset.get("size") or 0
    done = 0
    try:
        with httpx.stream("GET", asset["browser_download_url"],
                          headers=_gh_headers(), timeout=60,
                          follow_redirects=True) as r:
            if r.status_code != 200:
                raise UpdateError(f"asset download failed: HTTP {r.status_code}")
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1024 * 512):
                    f.write(chunk)
                    done += len(chunk)
                    if size:
                        job["progress"] = round(done / size, 3)
                        if done // (size // 4 or 1) != (done - len(chunk)) // (size // 4 or 1):
                            _log(job, f"  {done / 1e6:.0f} / {size / 1e6:.0f} MB")
    except httpx.HTTPError as exc:
        tmp.unlink(missing_ok=True)
        raise UpdateError(f"download failed: {exc}") from exc
    tmp.chmod(0o755)
    _log(job, f"downloaded {done / 1e6:.0f} MB — swapping on restart")
    job["phase"] = "restarting"
    _log(job, "restarting OSMP…")
    _restart(job, new_appimage=tmp)


# ── restart (the delicate bit) ───────────────────────────────────────

def _restart(job: dict, new_appimage: Path | None = None) -> None:
    cfg = get_config()
    job["phase"] = "restarting"
    if new_appimage is not None:
        path = appimage_path()
        data = cfg.data_dir
        port = cfg.port
        script = (f'sleep 2; mv -f "{new_appimage}" "{path}" && '
                  f'exec "{path}" --port {port} --data "{data}"')
        _log(job, f"relaunching AppImage on port {port}")
    else:
        root = repo_root()
        if not root:
            raise UpdateError("cannot determine repo root for relaunch")
        data = cfg.data_dir
        script = (f'sleep 2; cd "{root}" && exec {sys.executable} run.py '
                  f'--host {cfg.host} --port {cfg.port} --data "{data}" '
                  f'>> "{data}/server.log" 2>&1')
        _log(job, f"relaunching server on {cfg.host}:{cfg.port}")
    subprocess.Popen(["sh", "-c", script], start_new_session=True,
                     cwd=str(repo_root() or Path.home()),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    job["status"] = "done"
    _log(job, "✓ update applied — server is restarting")
    # give the HTTP response time to flush, then hand the port over
    threading.Timer(1.0, lambda: os._exit(0)).start()
