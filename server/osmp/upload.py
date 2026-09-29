"""Your-own-music imports: multipart uploads and server-side folder scans.

Uploaded files become first-class library tracks: tags and embedded cover
art are read with mutagen, the file lands in the library directory, and it
streams through the same ``/api/library/stream`` pipeline as yt-dlp
downloads. Track ids carry a ``local_`` prefix so they can never be
mistaken for YouTube video ids.

Scanning COPIES (never moves) — pointing it at a personal collection must
never empty the source folder.
"""
from __future__ import annotations

import logging
import shutil
import time
import uuid
from pathlib import Path

from . import db
from .config import Config, get_config

log = logging.getLogger("osmp.upload")

# what we accept as an audio file (by extension — mutagen validates content)
AUDIO_EXTS = {".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".opus", ".oga",
              ".wav", ".aac", ".wma"}
MAX_FILE_BYTES = 400 * 1024 * 1024   # per file
MAX_SCAN_FILES = 2000


def new_local_id() -> str:
    return "local_" + uuid.uuid4().hex[:12]


def is_local_id(track_id: str) -> bool:
    return track_id.startswith("local_")


# ---------------------------------------------------------------- tags

def read_tags(path: Path) -> dict:
    """Title/artist/album/duration via mutagen's easy layer (normalized
    across ID3/MP4/Vorbis/FLAC). Falls back to the filename stem."""
    out = {"title": None, "artist": None, "album": None, "duration": None}
    try:
        import mutagen
        audio = mutagen.File(str(path), easy=True)
        if audio is not None:
            out["duration"] = getattr(audio.info, "length", None)
            for key in ("title", "artist", "album"):
                v = audio.get(key)
                if isinstance(v, list):
                    v = v[0] if v else None
                if v:
                    out[key] = str(v).strip()
    except Exception as exc:  # noqa: BLE001 — tagging is best-effort, never fatal
        log.info("tag read failed for %s: %s", path.name, exc)
    if not out["title"]:
        out["title"] = path.stem.replace("_", " ").strip() or "Untitled"
    if not out["artist"]:
        out["artist"] = "Unknown artist"
    return out


def read_cover(path: Path) -> bytes | None:
    """Embedded front-cover bytes, best-effort across formats.

    Covers ID3 (mp3/aac), MP4 (m4a) and FLAC pictures — the formats that
    actually carry art in the wild. Vorbis block-picture parsing is skipped
    on purpose: rare in practice, fiddly to parse.
    """
    try:
        import mutagen
        audio = mutagen.File(str(path))
        if audio is None:
            return None
        covr = audio.tags.get("covr") if audio.tags else None
        if covr:
            return bytes(covr[0])
        for key in ("APIC", "PIC"):
            pics = audio.getall(key) if hasattr(audio, "getall") else []
            if pics and pics[0].data:
                return bytes(pics[0].data)
        if hasattr(audio, "pictures"):
            for pic in audio.pictures:
                if pic.data:
                    return bytes(pic.data)
    except Exception as exc:  # noqa: BLE001
        log.info("cover read failed for %s: %s", path.name, exc)
    return None


# ---------------------------------------------------------------- import

def import_file(src: Path, cfg: Config | None = None, *, move: bool = True,
                skip_duplicates: bool = True) -> dict:
    """Bring one audio file into the library; returns the track dict.

    ``move=True`` consumes ``src`` (the upload temp file); scanning passes
    ``move=False`` to copy. Duplicate detection matches an existing local
    track with the same duration (±2 s) and size.
    """
    cfg = cfg or get_config()
    if not src.is_file() or src.stat().st_size == 0:
        raise ValueError("empty or missing file")
    if src.suffix.lower() not in AUDIO_EXTS:
        raise ValueError(f"unsupported file type: {src.suffix or '(none)'}")

    tags = read_tags(src)
    size = src.stat().st_size

    if skip_duplicates and _looks_duplicate(tags, size, cfg):
        if move:
            src.unlink(missing_ok=True)
        raise FileExistsError("already in your library")

    track_id = new_local_id()
    dest = cfg.library_dir / f"{track_id}{src.suffix.lower()}"
    if move:
        shutil.move(str(src), dest)
    else:
        shutil.copy2(src, dest)

    cover = read_cover(dest)
    if cover:
        try:
            (cfg.covers_dir / f"{track_id}.jpg").write_bytes(cover)
        except OSError:
            pass

    track = {
        "id": track_id,
        "title": tags["title"],
        "artist": tags["artist"],
        "duration": round(tags["duration"], 2) if tags["duration"] else None,
        "thumbnail": f"/api/art/{track_id}" if cover else None,
        "source": "local",
    }
    db.upsert_track(track, cfg)
    db.set_track_file(track_id, str(dest), dest.stat().st_size, cfg)
    row = db.get_track(track_id, cfg) or track
    log.info("imported %s — %s by %s (%.0f s)", track_id, track["title"],
             track["artist"], tags["duration"] or 0)
    return row


def _looks_duplicate(tags: dict, size: int, cfg: Config) -> bool:
    dur = tags.get("duration")
    if not dur:
        return False
    for t in db.list_tracks(offline_only=True, limit=5000, cfg=cfg):
        if t.get("source") != "local":
            continue
        if t.get("file_size") != size:
            continue
        tdur = t.get("duration") or 0
        if abs(tdur - dur) <= 2 and (t.get("title") or "").lower() == (tags["title"] or "").lower():
            return True
    return False


# ---------------------------------------------------------------- scanning

def scan_directory(directory: str | Path, cfg: Config | None = None) -> dict:
    """Import every audio file under a server-side directory (copies only).

    Walks recursively, caps at MAX_SCAN_FILES, and reports per-file errors
    instead of failing the batch. Admin-gated at the API layer because it
    reads arbitrary server paths.
    """
    cfg = cfg or get_config()
    root = Path(directory).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"not a directory: {root}")
    if root == cfg.library_dir.resolve():
        raise ValueError("that's already the OSMP library — nothing to scan")

    found: list[Path] = []
    for p in root.rglob("*"):
        if len(found) >= MAX_SCAN_FILES:
            break
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
            found.append(p)

    imported: list[dict] = []
    duplicates = 0
    errors: list[str] = []
    for p in found:
        try:
            if p.stat().st_size > MAX_FILE_BYTES:
                errors.append(f"{p.name}: too large")
                continue
            imported.append(import_file(p, cfg, move=False))
        except FileExistsError:
            duplicates += 1
        except Exception as exc:  # noqa: BLE001 — one bad file skips itself
            errors.append(f"{p.name}: {exc}"[:200])

    log.info("scan of %s: %d imported, %d duplicates, %d errors",
             root, len(imported), duplicates, len(errors))
    return {"scanned": len(found), "imported": len(imported),
            "duplicates": duplicates, "errors": errors[:20],
            "tracks": imported[:500], "finished_at": time.time()}
