#!/usr/bin/env python3
"""OSMP server entry point.

Usage:
  python3 run.py [--host 127.0.0.1] [--port 8790] [--data DIR] [--open]
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

BANNER = r"""
  ____  ____  __  __ ____    OSMP — Open-Source Music Player
 / __ \/ ___||  \/  |  _ \   self-hosted · YouTube-backed · no npm in sight
| |  | \___ \| |\/| | |_) |
| |__| |___) | |  | |  __/  {url}
 \____/|____/|_|  |_|_|      data: {data}
"""


def main() -> None:
    p = argparse.ArgumentParser(description="Run the OSMP music server")
    p.add_argument("--host", default=os.environ.get("OSMP_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("OSMP_PORT", "8790")))
    p.add_argument("--data", default=None, help="data directory (default ~/.local/share/osmp)")
    p.add_argument("--open", action="store_true", help="open the UI in a browser on start")
    p.add_argument("--log-level", default="info")
    args = p.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    from osmp.config import Config, get_config, set_config
    set_config(Config(args.data))
    cfg = get_config()

    from osmp.main import create_app
    app = create_app(args.data)

    url = f"http://{args.host}:{args.port}"
    if args.host == "0.0.0.0":
        url = f"http://127.0.0.1:{args.port}"
    print(BANNER.format(url=url, data=cfg.data_dir))
    if not cfg.ffmpeg_path:
        print("  warning: ffmpeg not found — downloads still work (no remuxing),")
        print("           but consider installing it. See README.")

    if args.open:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level,
                access_log=False)


if __name__ == "__main__":
    main()
