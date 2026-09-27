"""Tiny localhost reverse proxy for the OSMP desktop client.

QtWebEngine only enables service workers on http://127.0.0.1 (a secure
context), so a remote plain-http OSMP server would lose the offline shell,
the audio cache and the sync outbox. The client therefore loads the UI from
this loopback proxy, which forwards everything to the real server —
streaming included (audio ranges pass through untouched).
"""
from __future__ import annotations

import asyncio
import logging
import socket
from urllib.parse import urlsplit

log = logging.getLogger("osmp.proxy")

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "proxy-connection", "te", "trailers", "transfer-encoding", "upgrade"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Proxy:
    def __init__(self, remote: str):
        u = urlsplit(remote if "://" in remote else "http://" + remote)
        self.scheme = u.scheme or "http"
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if self.scheme == "https" else 80)
        self.host_header = u.netloc or f"{self.host}:{self.port}"

    async def _upstream_connect(self):
        if self.scheme == "https":
            import ssl
            return await asyncio.open_connection(self.host, self.port, ssl=ssl.create_default_context())
        return await asyncio.open_connection(self.host, self.port)

    async def _pipe(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                chunk = await reader.read(64 * 1024)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
        except (ConnectionError, TimeoutError):
            pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def handle(self, creader: asyncio.StreamReader, cwriter: asyncio.StreamWriter):
        try:
            # ── request head ──
            line = await asyncio.wait_for(creader.readline(), 30)
            if not line:
                return
            method, target, _ver = line.decode("latin1").strip().split(" ", 2)
            headers = []
            content_length = 0
            chunked = False
            while True:
                h = await asyncio.wait_for(creader.readline(), 30)
                if h in (b"\r\n", b"\n", b""):
                    break
                name, _, val = h.decode("latin1").partition(":")
                name = name.strip()
                low = name.lower()
                if low in ("connection", "keep-alive"):
                    continue
                if low == "host":
                    continue  # rewritten below
                if low == "content-length":
                    content_length = int(val.strip())
                if low == "transfer-encoding" and "chunked" in val.lower():
                    chunked = True
                headers.append((name, val.strip()))
            if chunked:
                body = None  # streamed upload: let the pipe forward it verbatim
            else:
                body = await creader.read(content_length) if content_length else b""

            ureader, uwriter = await self._upstream_connect()
            req_host = self.host_header
            out = [f"{method} {target} HTTP/1.1", f"Host: {req_host}", "Connection: close"]
            for name, val in headers:
                if name.lower() == "connection":
                    continue
                out.append(f"{name}: {val}")
            payload = ("\r\n".join(out) + "\r\n\r\n").encode("latin1") + body
            uwriter.write(payload)
            await uwriter.drain()

            # ── response head ──
            rline = await asyncio.wait_for(ureader.readline(), 60)
            if not rline:
                cwriter.close()
                return
            cwriter.write(rline)
            uheaders = []
            while True:
                h = await asyncio.wait_for(ureader.readline(), 60)
                if h in (b"\r\n", b"\n", b""):
                    break
                name = h.decode("latin1").partition(":")[0].strip().lower()
                if name in ("connection", "keep-alive"):
                    continue  # we terminate keep-alive; length/TE headers pass through verbatim
                uheaders.append(h)
            cwriter.write(b"Connection: close\r\n")
            for h in uheaders:
                cwriter.write(h)
            cwriter.write(b"\r\n")
            await cwriter.drain()

            await asyncio.gather(
                self._pipe(ureader, cwriter),   # response body → client
                self._pipe(creader, uwriter),   # (rare) further client bytes → upstream
            )
        except (ConnectionError, asyncio.TimeoutError, ValueError) as exc:
            log.debug("proxy conn ended: %s", exc)
            try:
                cwriter.close()
            except Exception:  # noqa: BLE001
                pass

    async def serve(self, port: int, stop: asyncio.Event):
        server = await asyncio.start_server(self.handle, "127.0.0.1", port)
        log.info("osmp client proxy 127.0.0.1:%d → %s://%s:%d", port, self.scheme, self.host, self.port)
        async with server:
            await stop.wait()
            server.close()
            await server.wait_closed()


def start_proxy(remote: str) -> int:
    """Run the proxy on a free port in a daemon thread; returns the port."""
    port = free_port()
    stop = asyncio.Event()
    loop = asyncio.new_event_loop()
    proxy = Proxy(remote)

    def run():
        asyncio.set_event_loop(loop)
        loop.run_until_complete(proxy.serve(port, stop))

    import threading
    t = threading.Thread(target=run, daemon=True, name="osmp-proxy")
    t.start()
    return port
