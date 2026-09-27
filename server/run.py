#!/usr/bin/env python3
"""OSMP server entry point.

Usage:
  python3 run.py [--host 127.0.0.1] [--port 8790] [--data DIR] [--open]

Account recovery (safe to run while the server is up):
  python3 run.py --list-users
  python3 run.py --reset-password admin            (prompts, hidden input)
  python3 run.py --reset-password admin --password newpass
  python3 run.py --create-admin                    (only when no users exist)
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


def _boot_data_dir(args) -> None:
    from osmp.config import Config, set_config
    set_config(Config(args.data))


def manage_accounts(args) -> int:
    """--list-users / --reset-password / --create-admin: offline account ops.

    These talk straight to the server's SQLite (WAL), so they're safe while
    the server is running — that's the point: if you're locked out of the UI,
    the shell is still in charge.
    """
    _boot_data_dir(args)
    from osmp import auth
    from osmp.db import init_db
    init_db()

    if args.list_users:
        users = auth.list_users()
        if not users:
            print("no accounts yet — open the web UI once to create the admin")
        for u in users:
            tag = "admin" if u["role"] == "admin" else "listener"
            state = "" if u["active"] else " [disabled]"
            print(f"  {u['username']}  ({tag}){state}")
        return 0

    if args.create_admin:
        if not auth.setup_required():
            print("an admin already exists — use --reset-password instead")
            return 1
        import getpass
        username = input("admin username: ").strip()
        password = args.password or getpass.getpass("admin password: ")
        try:
            u = auth.create_user(username, password, role="admin")
        except ValueError as exc:
            print(f"error: {exc}")
            return 1
        print(f"created admin account: {u['username']}")
        return 0

    # --reset-password
    username = args.reset_password.strip()
    user = auth.find_user(username)
    if not user:
        print(f"no such user: {username} (try --list-users)")
        return 1
    password = args.password
    if not password:
        import getpass
        password = getpass.getpass(f"new password for {user['username']}: ")
        if password != getpass.getpass("confirm: "):
            print("passwords do not match")
            return 1
    try:
        auth.set_password(user["id"], password)
    except ValueError as exc:
        print(f"error: {exc}")
        return 1
    # kill their sessions so the new password takes effect immediately
    auth.drop_user_sessions(user["id"])
    print(f"password reset for {user['username']} — their sessions were signed out")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="Run the OSMP music server")
    p.add_argument("--host", default=os.environ.get("OSMP_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("OSMP_PORT", "8790")))
    p.add_argument("--data", default=None, help="data directory (default ~/.local/share/osmp)")
    p.add_argument("--open", action="store_true", help="open the UI in a browser on start")
    p.add_argument("--log-level", default="info")
    # account recovery
    p.add_argument("--list-users", action="store_true", help="list accounts and exit")
    p.add_argument("--reset-password", metavar="USER", help="set a user's password and sign them out")
    p.add_argument("--password", default=None, help="password for --reset-password (else prompted)")
    p.add_argument("--create-admin", action="store_true", help="create the admin account from the shell (only before setup)")
    args = p.parse_args()

    if args.list_users or args.reset_password or args.create_admin:
        sys.exit(manage_accounts(args))

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    from osmp.config import Config, get_config, set_config
    set_config(Config(args.data))
    cfg = get_config()
    # record the actual bind target so self-update can relaunch identically
    cfg.host = args.host
    cfg.port = args.port

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
