#!/usr/bin/env python3
"""OSMP desktop shell — a real app window around the OSMP server.

Bundles and boots the full server (FastAPI + yt-dlp + ffmpeg) in a thread,
then hosts the web UI in a Qt WebEngine window with a system tray.
Falls back to opening your default browser with --browser.

Flags:
  --port N      fixed server port (default: ephemeral free port)
  --data DIR    server data directory (default: shared ~/.local/share/osmp)
  --browser     don't open a window; serve + open default browser
  --smoke       headless self-test: boot server, load UI offscreen, exit
"""
from __future__ import annotations

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


def start_server(port: int, data_dir: str | None) -> None:
    """Run uvicorn in a daemon thread; the Qt app owns the process."""
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


def wait_ready(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main() -> int:
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args else _free_port()
    data_dir = args[args.index("--data") + 1] if "--data" in args else None
    browser_mode = "--browser" in args
    smoke = "--smoke" in args

    start_server(port, data_dir)
    url = f"http://127.0.0.1:{port}/"

    if browser_mode:
        if not wait_ready(port):
            print("OSMP server failed to start", file=sys.stderr)
            return 1
        print(f"OSMP serving at {url} — press Ctrl+C to stop")
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    if smoke:
        os.environ["QT_QPA_PLATFORM"] = "offscreen"

    from PySide6.QtCore import Qt, QUrl, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QMainWindow, QSystemTrayIcon, QMenu

    qapp = QApplication(sys.argv[:1])
    qapp.setApplicationName("OSMP")
    qapp.setOrganizationName("OSMP")
    icon_path = _resource_dir() / "webui" / "icons" / "icon-512.png"
    if icon_path.exists():
        qapp.setWindowIcon(QIcon(str(icon_path)))

    if not wait_ready(port):
        print("SMOKE_FAIL server did not become ready", file=sys.stderr)
        return 1

    from PySide6.QtWebEngineWidgets import QWebEngineView

    win = QMainWindow()
    win.setWindowTitle("OSMP")
    win.resize(1280, 860)
    view = QWebEngineView(win)
    win.setCentralWidget(view)

    state = {"loaded": False, "failed": False}

    def on_loaded(ok: bool):
        state["loaded"] = ok
        state["failed"] = not ok

    view.loadFinished.connect(on_loaded)
    view.load(QUrl(url))

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
