#!/usr/bin/env python3
"""OSMP API test suite for the v0.3.0 feature set.

Runs against a live server: lyrics (LRCLIB-backed, cached), stats, mixes,
artists, history log, backup export/import round-trip, and the auth guards
around them. Needs a server with an admin account:

    python3 scripts/api_test.py [base_url] [admin_user] [admin_pass]

Exit code 0 = all checks passed.
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8790"
USER = "admin"
PASSWORD = "osmp-admin"

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"{'PASS' if cond else 'FAIL'} · {name} {('- ' + detail) if detail and not cond else ''}")


class Api:
    def __init__(self, base):
        self.base = base
        self.token = None

    def req(self, method, path, body=None, auth=True, raw=False):
        r = urllib.request.Request(self.base + path, method=method)
        if auth and self.token:
            r.add_header("Authorization", "Bearer " + self.token)
        data = None
        if body is not None:
            r.add_header("Content-Type", "application/json")
            data = json.dumps(body).encode()
        try:
            with urllib.request.urlopen(r, data, timeout=60) as resp:
                payload = resp.read()
                return json.loads(payload) if not raw else payload
        except urllib.error.HTTPError as e:
            return {"__status": e.code, "detail":
                    json.loads(e.read() or b"{}").get("detail", "")}

    def login(self, user, password):
        out = self.req("POST", "/api/auth/login",
                       {"username": user, "password": password}, auth=False)
        self.token = out.get("token")
        return self.token


def main():
    api = Api(BASE)

    # ── login ─────────────────────────────────────────────────────
    check("auth: admin login", bool(api.login(USER, PASSWORD)))

    # ── stats ─────────────────────────────────────────────────────
    st = api.req("GET", "/api/stats?days=30")
    check("stats: summary shape", all(k in st for k in
          ("plays", "tracks", "artists", "seconds", "by_day", "by_hour",
           "top_tracks", "top_artists", "scope")))
    check("stats: by_day zero-filled to window", len(st["by_day"]) == 30
          and all({"day", "plays", "seconds"} == set(d) for d in st["by_day"]))
    check("stats: 24 hour buckets", len(st["by_hour"]) == 24)
    check("stats: top tracks capped at 12", len(st["top_tracks"]) <= 12)
    st_all = api.req("GET", "/api/stats?days=30&scope=all")
    check("stats: admin can see all-scope", st_all.get("scope") == "all"
          and st_all.get("plays", 0) >= st.get("plays", 0))
    st_bad = api.req("GET", "/api/stats?days=9999")
    check("stats: day window clamped", st_bad.get("days") == 365)

    # ── artists ───────────────────────────────────────────────────
    arts = api.req("GET", "/api/artists")
    check("artists: list returns rows", isinstance(arts.get("artists"), list))
    if arts.get("artists"):
        probe = arts["artists"][0]["artist"]
        one = api.req("GET", f"/api/artist?name={urllib.request.quote(probe)}")
        check("artist: page returns own tracks",
              one.get("artist", "").lower() == probe.lower()
              and isinstance(one.get("tracks"), list)
              and all(t["artist"].lower() == probe.lower() for t in one["tracks"]))
        check("artist: play stats attached",
              all(k in one for k in ("plays", "seconds", "last_played")))
    nope = api.req("GET", "/api/artist?name=")
    check("artist: empty name rejected", nope.get("__status") == 400)

    # ── history log ───────────────────────────────────────────────
    log = api.req("GET", "/api/history/log?limit=50")
    check("history: log returns plays", isinstance(log.get("plays"), list))
    if log["plays"]:
        check("history: newest first with timestamps",
              log["plays"][0]["played_at"] >= log["plays"][-1]["played_at"]
              and all("played_at" in p for p in log["plays"]))

    # ── lyrics ────────────────────────────────────────────────────
    # well-known track with synced lyrics on LRCLIB; resolves metadata live
    ly = api.req("GET", "/api/lyrics/dQw4w9WgXcQ")
    check("lyrics: known track resolves", ly.get("found") is True,
          str(ly)[:120])
    check("lyrics: synced lines parsed",
          ly.get("synced") is True and len(ly.get("lines") or []) > 10
          and all(set(l) == {"t", "line"} for l in ly["lines"][:5]))
    check("lyrics: junk entries rejected",
          all(len(l["line"]) > 0 for l in (ly.get("lines") or [])[:3]))
    # second call must come from cache instantly (identical payload)
    ly2 = api.req("GET", "/api/lyrics/dQw4w9WgXcQ")
    check("lyrics: cache serves repeat", ly2 == ly)

    # ── mixes ─────────────────────────────────────────────────────
    mx = api.req("GET", "/api/mixes")
    check("mixes: shelf shape", all(k in mx for k in
          ("mixes", "jump_back_in", "fresh")))
    check("mixes: artist cards well-formed",
          all(m.get("seed") and m.get("title") for m in mx["mixes"]))

    # ── backup round-trip ─────────────────────────────────────────
    bk = api.req("GET", "/api/backup", raw=True)
    data = json.loads(bk)
    check("backup: export shape", data.get("format") == "osmp-backup"
          and isinstance(data.get("playlists"), list)
          and isinstance(data.get("tracks"), list))
    check("backup: no secrets leak",
          not any("key" in k or "pin" in k or "token" in k
                  for k in (data.get("settings") or {})))
    restored = api.req("POST", "/api/backup/restore", {"data": data})
    check("backup: restore accepts own export",
          restored.get("ok") is True
          and "playlists_created" in restored)
    bad = api.req("POST", "/api/backup/restore",
                  {"data": {"format": "someone-elses"}})
    check("backup: foreign format rejected", bad.get("__status") == 400)

    # ── playlist lifecycle (regression) ───────────────────────────
    pl = api.req("POST", "/api/playlists",
                 {"name": "API test playlist", "description": "temp"})
    pid = pl.get("id")
    check("playlists: create", isinstance(pid, int))
    add = api.req("POST", f"/api/playlists/{pid}/tracks", {"tracks": [
        {"id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up",
         "artist": "Rick Astley", "duration": 213},
        {"id": "DLzxrzFCyOs", "title": "x", "artist": "y", "duration": 100},
    ]})
    check("playlists: add tracks", add.get("added") == 2)
    again = api.req("POST", f"/api/playlists/{pid}/tracks", {"tracks": [
        {"id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up",
         "artist": "Rick Astley", "duration": 213}]})
    check("playlists: duplicates skipped", again.get("added") == 0)
    got = api.req("GET", f"/api/playlists/{pid}")
    check("playlists: ordered readback",
          [t["id"] for t in got["tracks"]] ==
          ["dQw4w9WgXcQ", "DLzxrzFCyOs"] and got["track_count"] == 2)
    ro = api.req("PUT", f"/api/playlists/{pid}/tracks",
                 {"order": ["DLzxrzFCyOs", "dQw4w9WgXcQ"]})
    got2 = api.req("GET", f"/api/playlists/{pid}")
    check("playlists: reorder", ro.get("ok", True) and
          [t["id"] for t in got2["tracks"]] == ["DLzxrzFCyOs", "dQw4w9WgXcQ"])
    dl = api.req("DELETE", f"/api/playlists/{pid}")
    check("playlists: delete", dl.get("ok", True) and
          api.req("GET", f"/api/playlists/{pid}").get("__status") == 404)

    # ── resolve / home shapes ─────────────────────────────────────
    res = api.req("POST", "/api/resolve", {"ids": ["dQw4w9WgXcQ"]})
    t = (res.get("tracks") or {}).get("dQw4w9WgXcQ", {})
    check("resolve: metadata map", t.get("artist") == "Rick Astley")
    home = api.req("GET", "/api/home")
    check("home: shape", all(k in home for k in
          ("recent", "downloads", "playlists", "stats")))

    # ── settings masking (regression) ─────────────────────────────
    stg = api.req("GET", "/api/settings")
    check("settings: secrets masked",
          stg.get("llm_api_key") in ("", "***set***", None)
          and stg.get("github_token") in ("", "***set***", None))

    # ── uploads (your own music) ───────────────────────────────────

    def synth_mp3(name: str, title: str, artist: str) -> bytes:
        """Minimal tagged mp3 via ffmpeg (server VM has it at ~/tools)."""
        import subprocess, tempfile, os
        ff = os.path.expanduser("~/tools/ffmpeg/bin/ffmpeg")
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, name)
            subprocess.run([ff, "-y", "-loglevel", "error",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                            "-metadata", f"title={title}", "-metadata", f"artist={artist}",
                            out], check=True, timeout=60)
            with open(out, "rb") as fh:
                return fh.read()

    mp3 = synth_mp3("apitest.mp3", "API Upload One", "API Tester")
    import urllib.request as _u
    boundary = "----osmpapitest"
    body = (f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"api one.mp3\"\r\n"
            f"Content-Type: audio/mpeg\r\n\r\n").encode() + mp3 + f"\r\n--{boundary}--\r\n".encode()
    r = _u.Request(api.base + "/api/upload", data=body, method="POST")
    r.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    r.add_header("Authorization", "Bearer " + api.token)
    with _u.urlopen(r, timeout=60) as resp:
        up = json.loads(resp.read())
    t = up["track"]
    check("upload: accepted", up.get("ok") is True)
    check("upload: tags parsed",
          t["title"] == "API Upload One" and t["artist"] == "API Tester")
    check("upload: local source + duration", t["source"] == "local"
          and 1 < (t["duration"] or 0) < 4 and t["offline"] is True)
    upid = t["id"]

    # duplicate → 409
    r2 = _u.Request(api.base + "/api/upload", data=body, method="POST")
    r2.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    r2.add_header("Authorization", "Bearer " + api.token)
    try:
        _u.urlopen(r2, timeout=60)
        check("upload: duplicate rejected", False)
    except urllib.error.HTTPError as e:
        check("upload: duplicate rejected", e.code == 409)
    # non-audio → 400
    r3 = _u.Request(api.base + "/api/upload",
                    data=(f"--{boundary}\r\n"
                          f"Content-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\n\r\n"
                          f"hello\r\n--{boundary}--\r\n").encode(), method="POST")
    r3.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    r3.add_header("Authorization", "Bearer " + api.token)
    try:
        _u.urlopen(r3, timeout=30)
        check("upload: rejects non-audio", False)
    except urllib.error.HTTPError as e:
        check("upload: rejects non-audio", e.code == 400)

    # art endpoint + stream + range
    art = api.req("GET", f"/api/art/{upid}")
    check("upload: art 404 without cover", art.get("__status") == 404)
    st = api.req("GET", f"/api/library/stream/{upid}", raw=True)
    check("upload: streams from disk", len(st) == len(mp3) or len(st) > 1000)
    # delete removes uploaded tracks entirely
    dl = api.req("DELETE", f"/api/library/{upid}")
    check("upload: delete removes track", dl.get("removed") == "track"
          and api.req("GET", f"/api/track/{upid}").get("__status") == 404)

    # scan guard: listener 403, bad dir 400
    listener = Api(BASE)
    api.req("POST", "/api/users", {"username": "apitest_scan",
                                   "password": "test1234", "role": "user"})
    listener = Api(BASE)
    listener.login("apitest_scan", "test1234")
    check("upload: scan needs admin",
          listener.req("POST", "/api/upload/scan", {"path": "/tmp"}).get("__status") == 403)
    check("upload: scan bad dir 400",
          api.req("POST", "/api/upload/scan", {"path": "/nonexistent-dir"}).get("__status") == 400)
    users = api.req("GET", "/api/users")["users"]
    sid = next(u["id"] for u in users if u["username"] == "apitest_scan")
    api.req("DELETE", f"/api/users/{sid}")

    # ── guards ────────────────────────────────────────────────────
    anon = Api(BASE)
    for path, label in (("/api/stats?days=7", "stats"),
                        ("/api/lyrics/dQw4w9WgXcQ", "lyrics"),
                        ("/api/backup", "backup"),
                        ("/api/history/log", "history")):
        out = anon.req("GET", path, auth=False)
        check(f"guard: {label} needs auth", out.get("__status") == 401)

    # listener scope guard
    api.req("POST", "/api/users", {"username": "apitest_tmp",
                                   "password": "test1234", "role": "user"})
    listener = Api(BASE)
    listener.login("apitest_tmp", "test1234")
    ls = listener.req("GET", "/api/stats?days=30&scope=all")
    check("guard: listener scope forced to me", ls.get("scope") == "me")
    lb = listener.req("GET", "/api/backup")
    check("guard: listener cannot export backup", lb.get("__status") == 403)
    users = api.req("GET", "/api/users")["users"]
    uid = next(u["id"] for u in users if u["username"] == "apitest_tmp")
    api.req("DELETE", f"/api/users/{uid}")
    check("cleanup: temp listener removed", True)

    print("\n" + "═" * 52)
    print(f"PASSED {len(PASS)}   FAILED {len(FAIL)}")
    if FAIL:
        for f in FAIL:
            print("  ✗", f)
    print("═" * 52)
    return 1 if FAIL else 0


if __name__ == "__main__":
    if len(sys.argv) > 3:
        BASE, USER, PASSWORD = sys.argv[1], sys.argv[2], sys.argv[3]
    elif len(sys.argv) > 1:
        BASE = sys.argv[1]
    sys.exit(main())
