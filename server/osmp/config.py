"""Runtime configuration: data directories, ffmpeg discovery, server defaults."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

# Locations we look in for a static ffmpeg, in order, after $PATH.
_FFMPEG_EXTRA_PATHS = [
    Path.home() / "tools" / "ffmpeg" / "bin",
    Path(__file__).resolve().parent.parent / "vendor" / "ffmpeg",  # bundled (AppImage)
    Path("/usr/local/bin"),
]


class Config:
    def __init__(self, data_dir: str | os.PathLike | None = None):
        env_data = os.environ.get("OSMP_DATA")
        base = Path(data_dir or env_data or (Path.home() / ".local" / "share" / "osmp"))
        self.data_dir: Path = base
        self.library_dir: Path = base / "library"
        self.covers_dir: Path = base / "covers"
        self.db_path: Path = base / "osmp.db"
        self.config_path: Path = base / "config.json"

        for d in (base, self.library_dir, self.covers_dir):
            d.mkdir(parents=True, exist_ok=True)

        self.ffmpeg_path: str | None = self._find_ffmpeg()
        self.host = os.environ.get("OSMP_HOST", "127.0.0.1")
        self.port = int(os.environ.get("OSMP_PORT", "8790"))

    @staticmethod
    def _find_ffmpeg() -> str | None:
        env = os.environ.get("OSMP_FFMPEG")
        if env and Path(env).is_file():
            return env
        found = shutil.which("ffmpeg")
        if found:
            return found
        for d in _FFMPEG_EXTRA_PATHS:
            cand = d / "ffmpeg"
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand)
        return None


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config


def set_config(cfg: Config) -> None:
    global _config
    _config = cfg
