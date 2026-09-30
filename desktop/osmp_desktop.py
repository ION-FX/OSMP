#!/usr/bin/env python3
"""OSMP desktop — a Nextcloud-style client for your self-hosted OSMP server.

First run asks for the server (URL + account) and connects; a checkbox offers
"run a server on this computer" instead. Remote sessions go through a tiny
localhost reverse proxy so the UI gets a secure context — that keeps the
service worker alive, which is what makes offline playback and change-sync
work even when the real server is plain http.

Flags:
  --server URL   connect to this server, skipping the dialog
  --local        skip the dialog, run the bundled server on this machine
  --port N       (local mode) fixed server port
  --data DIR     (local mode) server data directory
  --browser      don't open a window; serve locally + open default browser
  --smoke        headless self-test: boot, load UI offscreen, exit
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# Chromium inside AppImages cannot use the setuid sandbox.
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--no-sandbox")

if sys.platform == "win32":
    # the asyncio proxy (and any embedded uvicorn) needs the selector loop
    # on Windows; nothing here uses async subprocesses, so this is safe
    import asyncio
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _config_file() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "osmp" / "desktop.json"
    return Path.home() / ".config" / "osmp" / "desktop.json"


CFG_FILE = _config_file()


def _resource_dir() -> Path:
    """Where bundled data lives: PyInstaller _internal or repo checkout."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load_cfg() -> dict:
    try:
        return json.loads(CFG_FILE.read_text())
    except Exception:  # noqa: BLE001
        return {}


def save_cfg(cfg: dict) -> None:
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(cfg, indent=2))


def start_local_server(port: int, data_dir: str | None) -> None:
    """Run the bundled uvicorn server in a daemon thread."""
    sys.path.insert(0, str(_resource_dir() / "server"))
    from osmp.config import Config, set_config
    set_config(Config(data_dir))
    from osmp.main import create_app
    import uvicorn

    app = create_app(data_dir)
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                         access_log=False, lifespan="on")
    server = uvicorn.Server(cfg)
    t = threading.Thread(target=server.run, daemon=True, name="osmp-server")
    t.start()


def wait_ready(url: str, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url.rstrip('/') + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def server_login(base_url: str, username: str, password: str) -> dict | None:
    """POST /api/auth/login → {token, user} or None."""
    body = json.dumps({"username": username, "password": password}).encode()
    req = urllib.request.Request(base_url.rstrip('/') + "/api/auth/login", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return None


def connect_dialog(qapp) -> dict | None:
    """Native first-run dialog → {mode:'client', url, token} or {mode:'local'} or None."""
    from PySide6.QtWidgets import (QDialog, QVBoxLayout, QLabel, QLineEdit,
                                   QPushButton, QCheckBox, QHBoxLayout)

    dlg = QDialog()
    dlg.setWindowTitle("Connect to OSMP")
    dlg.setModal(True)
    dlg.resize(460, 280)
    lay = QVBoxLayout(dlg)

    head = QLabel("🎧  O S M P")
    head.setStyleSheet("font-size:22px;font-weight:800;")
    lay.addWidget(head)
    sub = QLabel("Your server address and account — like Nextcloud, but for music.\n"
                 "No server yet? Run one on this computer and reach it from every device.")
    sub.setWordWrap(True)
    lay.addWidget(sub)

    url_in = QLineEdit()
    url_in.setPlaceholderText("Server address — http://192.168.1.20:8790")
    user_in = QLineEdit()
    user_in.setPlaceholderText("Username")
    pass_in = QLineEdit()
    pass_in.setPlaceholderText("Password")
    pass_in.setEchoMode(QLineEdit.Password)
    for w in (url_in, user_in, pass_in):
        lay.addWidget(w)

    err = QLabel("")
    err.setStyleSheet("color:#f87171;font-size:12px;")
    err.setWordWrap(True)
    lay.addWidget(err)

    local_cb = QCheckBox("Run a server on this computer instead")
    lay.addWidget(local_cb)

    row = QHBoxLayout()
    go = QPushButton("Connect")
    go.setDefault(True)
    cancel = QPushButton("Quit")
    row.addWidget(go)
    row.addWidget(cancel)
    lay.addLayout(row)

    def on_local_toggle(on):
        for w in (user_in, pass_in):
            w.setEnabled(not on)
        go.setText("Start local server" if on else "Connect")

    local_cb.toggled.connect(on_local_toggle)

    def do_connect():
        base = url_in.text().strip()
        if local_cb.isChecked():
            save_cfg({"mode": "local"})
            dlg.accept(); return
        if not base:
            err.setText("Enter the server address."); return
        if not base.startswith(("http://", "https://")):
            base = "http://" + base
        base = base.rstrip('/')
        err.setText("Connecting…"); qapp.processEvents()
        if not wait_ready(base, timeout=8):
            err.setText(f"Could not reach an OSMP server at {base}"); return
        res = server_login(base, user_in.text().strip(), pass_in.text())
        if not res or not res.get("token"):
            err.setText("Wrong username or password — accounts are managed on the server (Settings → Accounts).")
            return
        save_cfg({"mode": "client", "url": base, "token": res["token"]})
        dlg.accept()

    go.clicked.connect(do_connect)
    pass_in.returnPressed.connect(do_connect)
    url_in.returnPressed.connect(lambda: user_in.setFocus())
    cancel.clicked.connect(dlg.reject)
    dlg.exec()
    return load_cfg() if dlg.result() else None


def main() -> int:
    args = sys.argv[1:]
    flag = lambda name: (args[args.index(name) + 1] if name in args else None)  # noqa: E731
    port = int(flag("--port")) if flag("--port") else _free_port()
    data_dir = flag("--data")
    browser_mode = "--browser" in args
    smoke = "--smoke" in args

    client_url = None      # what we load in the webview
    session_token = None
    cfg = load_cfg()
    if "--local" in args or (smoke and not flag("--server")):
        cfg = {"mode": "local"}
    elif flag("--server"):
        base = flag("--server").rstrip('/')
        if not wait_ready(base, timeout=10):
            print(f"OSMP server not reachable at {base}", file=sys.stderr)
            return 1
        cfg = {"mode": "client", "url": base, "token": flag("--token")}
        client_url = base  # smoke path loads the server directly

    if client_url is None:
        if browser_mode:
            cfg = {"mode": "local"}  # helper mode always uses the bundled server
        elif not cfg or cfg.get("mode") not in ("client", "local"):
            from PySide6.QtWidgets import QApplication
            qapp = QApplication(sys.argv[:1])
            qapp.setApplicationName("OSMP")
            chosen = connect_dialog(qapp)
            if not chosen:
                return 0
            cfg = chosen

    if cfg["mode"] == "local":
        start_local_server(port, data_dir)
        client_url = f"http://127.0.0.1:{port}"
    else:
        from osmp_proxy import start_proxy
        proxy_port = start_proxy(cfg["url"])
        client_url = f"http://127.0.0.1:{proxy_port}"
        session_token = cfg.get("token")

    if not wait_ready(client_url):
        print("OSMP server did not become ready", file=sys.stderr)
        return 1

    if browser_mode:
        if not wait_ready(client_url):
            print("OSMP server failed to start", file=sys.stderr)
            return 1
        print(f"OSMP serving at {client_url} — press Ctrl+C to stop")
        webbrowser.open(client_url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    if smoke:
        os.environ["QT_QPA_PLATFORM"] = "offscreen"

    from PySide6.QtCore import QUrl, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QMainWindow, QSystemTrayIcon, QMenu

    qapp = QApplication(sys.argv[:1])
    qapp.setApplicationName("OSMP")
    qapp.setOrganizationName("OSMP")
    icon_path = _resource_dir() / "webui" / "icons" / "icon-512.png"
    if icon_path.exists():
        qapp.setWindowIcon(QIcon(str(icon_path)))

    from PySide6.QtWebEngineWidgets import QWebEngineView

    win = QMainWindow()
    win.setWindowTitle("OSMP")
    win.resize(1280, 860)
    view = QWebEngineView(win)
    win.setCentralWidget(view)

    if session_token:
        from PySide6.QtNetwork import QNetworkCookie
        cookie = QNetworkCookie(b"osmp_session", session_token.encode())
        cookie.setPath("/")
        view.page().profile().cookieStore().setCookie(cookie, QUrl(client_url))

    state = {"loaded": False, "failed": False}

    def on_loaded(ok: bool):
        state["loaded"] = ok
        state["failed"] = not ok

    view.loadFinished.connect(on_loaded)
    view.load(QUrl(client_url))

    # system tray (absent on offscreen/headless — guarded)
    tray = None
    if QSystemTrayIcon.isSystemTrayAvailable() and not smoke:
        tray = QSystemTrayIcon(qapp.windowIcon(), qapp)
        menu = QMenu()
        act_show = menu.addAction("Show OSMP")
        act_play = menu.addAction("Play / Pause")
        act_next = menu.addAction("Next track")
        menu.addSeparator()
        act_quit = menu.addAction("Quit")
        act_show.triggered.connect(lambda: (win.show(), win.raise_()))
        act_play.triggered.connect(
            lambda: view.page().runJavaScript("window.__osmpMedia && __osmpMedia('toggle')"))
        act_next.triggered.connect(
            lambda: view.page().runJavaScript("window.__osmpMedia && __osmpMedia('next')"))
        act_quit.triggered.connect(qapp.quit)
        tray.setContextMenu(menu)
        tray.setToolTip("OSMP")
        tray.activated.connect(
            lambda reason: (win.show(), win.raise_())
            if reason == QSystemTrayIcon.Trigger else None)
        tray.show()

    def close_to_tray(event):
        if tray is not None and tray.isVisible():
            event.ignore()
            win.hide()
        else:
            event.accept()

    win.closeEvent = close_to_tray

    if smoke:
        def check():
            if state["loaded"]:
                title = view.title() or ""
                print(f"SMOKE_OK url={view.url().toString()} title={title!r}")
                qapp.exit(0)
            elif state["failed"]:
                print("SMOKE_FAIL page load failed", file=sys.stderr)
                qapp.exit(2)
        QTimer.singleShot(18000, lambda: (print("SMOKE_FAIL timeout", file=sys.stderr),
                                          qapp.exit(3)) if not state["loaded"] else None)
        view.loadFinished.connect(lambda ok: QTimer.singleShot(1500, check) if ok else None)
        return qapp.exec()

    win.show()
    return qapp.exec()


if __name__ == "__main__":
    sys.exit(main())
