#!/usr/bin/env python3
"""OSMP web-UI smoke test — headless Chromium via Playwright (Python).

Drives the real app against the real server (and real YouTube):
boot → search → play → controls → queue → sleep dialog → themes → radio.
Screenshots land in SHOTS dir for visual review.

Usage: python3 scripts/ui_test.py [base_url] [shots_dir]
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790"
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/osmp-shots")
SHOTS.mkdir(parents=True, exist_ok=True)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"{'PASS' if cond else 'FAIL'} · {name} {('- ' + detail) if detail and not cond else ''}")


def shot(page, name):
    page.screenshot(path=str(SHOTS / f"{name}.png"))
    print(f"  📸 {name}.png")


def main():
    console_errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--autoplay-policy=no-user-gesture-required",
                  "--mute-audio", "--force-device-scale-factor=1"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: console_errors.append(m.text)
                if m.type in ("error",) else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # ── boot + login ─────────────────────────────────────
        page.goto(BASE, wait_until="load", timeout=30000)
        page.wait_for_selector("#auth-form", state="visible", timeout=15000)
        check("auth: login gate shown", True)
        page.fill("#auth-user", "admin")
        page.fill("#auth-pass", "osmp-admin")
        page.click("#auth-go")
        page.wait_for_selector("#app:not(.hidden)", timeout=20000)
        time.sleep(1.2)
        check("boot: app visible", page.is_visible("#app"))
        check("boot: user chip shows admin",
              "admin" in (page.text_content("#user-name") or ""))
        shot(page, "01-home")

        # stub the Android bridge so media-notification payloads are observable
        page.evaluate("""() => {
          window.__mediaCalls = [];
          window.OsmpBridge = {
            notifyMedia: (s) => window.__mediaCalls.push(s),
            isDownloaded: () => false,
            notifyDownload: () => {},
            setWakeLock: () => {},
            notifyPlaying: () => {},
          };
        }""")

        # ── accounts: add + remove a user (admin) ────────────
        page.click("#btn-settings")
        page.wait_for_selector("#st-accounts", timeout=8000)
        page.fill("#st-new-user", "listener")
        page.fill("#st-new-pass", "listen123")
        page.click("#st-user-add")
        time.sleep(1.2)
        ulist = page.text_content("#st-users-list") or ""
        check("accounts: user added", "listener" in ulist, ulist[:80])
        # remove them again (their row's trash button) — confirm() fires a dialog
        page.on("dialog", lambda d: d.accept())
        page.locator("#st-users-list .row", has_text="listener").locator(".icon-btn").last.click()
        time.sleep(1.2)
        ulist = page.text_content("#st-users-list") or ""
        check("accounts: user removed", "listener" not in ulist, ulist[:80])
        page.click('a[data-route="home"]')

        # ── search & play ─────────────────────────────────────
        page.click('a[data-route="search"]')
        page.wait_for_selector("#sr-input", timeout=8000)
        page.fill("#sr-input", "daft punk get lucky")
        page.keyboard.press("Enter")
        page.wait_for_selector(".tl-row", timeout=30000)
        time.sleep(0.8)
        rows = page.locator(".tl-row").count()
        check("search: results rendered", rows >= 3, f"rows={rows}")
        shot(page, "02-search")

        page.click(".tl-row >> nth=0")
        page.wait_for_selector("#player-bar:not(.hidden)", timeout=10000)
        # give the stream time to resolve + buffer
        played = False
        for _ in range(24):
            time.sleep(1)
            t = page.evaluate("document.getElementById('audio-el').currentTime")
            if t and t > 0.5:
                played = True
                break
        check("play: audio advancing", played)
        title = page.text_content("#pb-title")
        check("play: player bar shows title", bool(title and title != "Nothing playing"), str(title))
        time.sleep(1.5)
        shot(page, "03-playing")

        # ── resilience: a refused stream is retried, not skipped ──
        # Separate context with the service worker blocked: Playwright's
        # page.route can't intercept requests the SW proxies.
        rctx = browser.new_context(viewport={"width": 1440, "height": 900},
                                   service_workers="block")
        p2 = rctx.new_page()
        p2.goto(BASE, wait_until="load", timeout=30000)
        p2.wait_for_selector("#auth-form", state="visible", timeout=15000)
        p2.fill("#auth-user", "admin")
        p2.fill("#auth-pass", "osmp-admin")
        p2.click("#auth-go")
        p2.wait_for_selector("#app:not(.hidden)", timeout=20000)
        refused = {"n": 0}

        def refuse_first(route):
            url = route.request.url
            if refused["n"] == 0 and "/api/stream/" in url and "retry=" not in url:
                refused["n"] += 1
                route.fulfill(status=502, content_type="application/json",
                              body='{"detail":"simulated YouTube refusal"}')
            else:
                route.continue_()

        p2.route("**/api/stream/**", refuse_first)
        p2.click('a[data-route="search"]')
        p2.wait_for_selector("#sr-input", timeout=8000)
        p2.fill("#sr-input", "daft punk get lucky")
        p2.keyboard.press("Enter")
        p2.wait_for_selector(".tl-row", timeout=30000)
        time.sleep(0.8)
        want = (p2.locator(".tl-row").nth(0).locator(".tl-title").text_content() or "").strip()
        p2.click(".tl-row >> nth=0")
        retried_ok = False
        for _ in range(30):
            time.sleep(1)
            t = p2.evaluate("document.getElementById('audio-el').currentTime")
            if t and t > 0.5:
                retried_ok = True
                break
        check("resilience: refused stream retried, not skipped",
              retried_ok and refused["n"] == 1, f"refused={refused['n']}")
        got = (p2.text_content("#pb-title") or "").strip()
        check("resilience: clicked track still plays",
              bool(want) and (want in got or got in want), f"want={want!r} got={got!r}")
        p2.unroute("**/api/stream/**")
        rctx.close()

        # ── controls ──────────────────────────────────────────
        page.click("#pb-play")  # pause
        time.sleep(0.4)
        paused = page.evaluate("document.getElementById('audio-el').paused")
        check("controls: pause works", paused)
        page.click("#pb-play")  # resume
        time.sleep(0.4)
        check("controls: resume works", not page.evaluate("document.getElementById('audio-el').paused"))

        # v0.5.3: codec negotiation — auto format follows device capability
        neg = page.evaluate("""async () => {
          const mod = await import('/js/api.js');
          const kept = localStorage.getItem('osmp.format');
          localStorage.removeItem('osmp.format');
          const out = {};
          out.aacDetected = mod.canDecodeAac();                 // true in Chromium
          out.autoUrl = mod.streamUrl({ id: 'dQw4w9WgXcQ', offline: false });
          out.offlineUrl = mod.streamUrl({ id: 'dQw4w9WgXcQ', offline: true });
          localStorage.setItem('osmp.format', 'opus');
          out.forcedUrl = mod.streamUrl({ id: 'dQw4w9WgXcQ', offline: false });
          if (kept) localStorage.setItem('osmp.format', kept);
          else localStorage.removeItem('osmp.format');
          return out;
        }""")
        check("negotiation: Chromium detects AAC → auto=m4a",
              neg["aacDetected"] is True and neg["autoUrl"].endswith("fmt=m4a")
              and "?fmt=" not in neg["offlineUrl"],
              str(neg))
        check("negotiation: explicit format wins",
              neg["forcedUrl"].endswith("fmt=opus"), str(neg))

        # v0.5.4: setIcon fill passthrough (the like heart fills when active)
        fillOk = page.evaluate("""async () => {
          const { setIcon } = await import('/js/components/icons.js');
          const b = document.createElement('button');
          setIcon(b, 'heart', 19, true);
          return b.querySelector('svg').getAttribute('fill') === 'currentColor';
        }""")
        check("icons: setIcon honors fill (like heart)", fillOk)

        # v0.5.2: the Android notification must never lose its metadata —
        # every bridge payload (including play/pause toggles) carries a title
        mstate = page.evaluate("""() => {
          const calls = (window.__mediaCalls || []).map(s => JSON.parse(s));
          return { n: calls.length,
                   noTitle: calls.filter(c => !c.title).length,
                   last: calls[calls.length - 1] || {} };
        }""")
        check("media: every notification payload has a title",
              mstate["n"] >= 3 and mstate["noTitle"] == 0 and bool(mstate["last"].get("artist")),
              str(mstate))

        # repeat cycle
        page.click("#pb-repeat"); time.sleep(0.2)
        check("controls: repeat all", "Repeat queue" in (page.get_attribute("#pb-repeat", "title") or ""))
        page.click("#pb-repeat"); time.sleep(0.2)
        check("controls: repeat one badge", page.locator("#pb-repeat .rep-one").count() == 1)
        page.click("#pb-repeat"); time.sleep(0.2)
        check("controls: repeat off", "Repeat off" in (page.get_attribute("#pb-repeat", "title") or ""))

        page.click("#pb-shuffle"); time.sleep(0.2)
        check("controls: shuffle toggles on", "on" in (page.get_attribute("#pb-shuffle", "class") or ""))
        page.click("#pb-shuffle"); time.sleep(0.2)

        # seek
        page.evaluate("""() => {
            const a = document.getElementById('audio-el');
            a.currentTime = Math.min(30, (a.duration||60)/2);
        }""")
        time.sleep(0.6)
        cur = page.evaluate("document.getElementById('audio-el').currentTime")
        check("controls: seek applied", cur > 10, f"currentTime={cur}")

        # volume
        page.evaluate("document.getElementById('pb-vol').value = 40; document.getElementById('pb-vol').dispatchEvent(new Event('input'))")
        time.sleep(0.3)
        vol = page.evaluate("document.getElementById('audio-el').volume")
        check("controls: volume 0.4", abs(vol - 0.4) < 0.02, f"vol={vol}")

        # ── queue drawer ──────────────────────────────────────
        page.click("#pb-queue")
        page.wait_for_selector("#queue-drawer.open", timeout=5000)
        time.sleep(0.6)
        shot(page, "04-queue")
        page.click("#qd-close")
        page.wait_for_function(
            "() => !document.getElementById('queue-drawer').classList.contains('open')",
            timeout=5000)

        # ── sleep timer dialog ────────────────────────────────
        page.click("#pb-sleep")
        page.wait_for_selector(".modal", timeout=5000)
        time.sleep(0.5)
        shot(page, "05-sleep-dialog")
        page.click('.sleep-grid .chip[data-min="15"]')
        time.sleep(0.8)
        visible = page.is_visible("#pb-sleep-count")
        check("sleep: countdown badge visible", visible)
        # clear it again via dialog
        page.click("#pb-sleep"); page.wait_for_selector(".modal", timeout=5000)
        page.click("#sl-clear"); time.sleep(0.6)
        check("sleep: cleared", not page.is_visible("#pb-sleep-count")
              or page.text_content("#pb-sleep-count") == "")

        # ── now playing overlay ───────────────────────────────
        page.click("#pb-cover-btn")
        page.wait_for_selector("#np-overlay:not(.hidden)", timeout=5000)
        time.sleep(1.2)
        shot(page, "06-now-playing")
        page.click("#np-close")
        time.sleep(0.6)

        # ── radio ─────────────────────────────────────────────
        page.click('a[data-route="radio"]')
        page.wait_for_selector("#rd-seed", timeout=8000)
        page.fill("#rd-seed", "synthwave night drive")
        page.click("#rd-go")
        page.wait_for_selector("#rr-list .tl-row", timeout=90000)
        time.sleep(1)
        rrows = page.locator("#rr-list .tl-row").count()
        check("radio: generated tracks", rrows >= 10, f"rows={rrows}")
        shot(page, "07-radio")

        # save radio as playlist
        page.click("#rr-save")
        page.wait_for_selector(".modal", timeout=5000)
        page.fill(".modal input", "Night Drive Test")
        page.click('.modal [data-act="ok"]')
        time.sleep(1.5)
        # toast with "Created" should appear; sidebar should list it
        pls = page.text_content("#sidebar-playlists")
        check("radio: saved playlist appears in sidebar", "Night Drive Test" in (pls or ""), str(pls)[:100])

        # ── library view ──────────────────────────────────────
        page.click('a[data-route="library"]')
        page.wait_for_selector("#lb-playlists", timeout=8000)
        time.sleep(1.5)
        shot(page, "08-library")

        # open the playlist we just saved
        page.click("#lb-playlists .card >> nth=0")
        page.wait_for_selector("#pl-list .tl-row", timeout=10000)
        time.sleep(1)
        shot(page, "09-playlist")

        # ── import: playlist URL in search routes to importer ──
        NCS = "https://www.youtube.com/playlist?list=PLRBp0Fe2GpgnIh0AiYKh7o7HnYAej-5ph"
        page.click('a[data-route="search"]')
        page.wait_for_selector("#sr-input", timeout=8000)
        page.fill("#sr-input", NCS)
        page.press("#sr-input", "Enter")
        page.wait_for_function("location.hash.startsWith('#/import')", timeout=10000)
        check("import: search link routes to importer", page.evaluate("location.hash.startsWith('#/import?url=')"))

        # preview renders with selectable tracks
        page.wait_for_selector("#imp-rows .imp-row", timeout=90000)
        time.sleep(0.8)
        irows = page.locator("#imp-rows .imp-row").count()
        check("import: preview rendered", irows >= 50, f"rows={irows}")
        check("import: truncated badge on big playlist",
              "first 500" in (page.text_content("#imp-head") or ""))
        shot(page, "09a-import-preview")

        # selection controls
        page.click("#imp-none")
        time.sleep(0.3)
        check("import: none disables button", page.is_disabled("#imp-do"))
        page.click("#imp-all")
        time.sleep(0.3)
        check("import: all re-enables", not page.is_disabled("#imp-do"))
        n_off = page.locator("#imp-rows .imp-row.unchecked").count()
        first_row = page.locator("#imp-rows .imp-row >> nth=0")
        first_row.click()
        time.sleep(0.3)
        check("import: row click toggles checkbox",
              page.locator("#imp-rows .imp-row.unchecked").count() == n_off + 1)

        # import 499 of 500 into a named playlist
        page.fill("#imp-name", "Import Test Mix")
        page.click("#imp-do")
        page.wait_for_selector("#pl-list .tl-row", timeout=30000)
        time.sleep(1.2)
        prow = page.locator("#pl-list .tl-row").count()
        check("import: playlist created from selection", prow == irows - 1, f"rows={prow}/{irows - 1}")
        check("import: landed on playlist view", page.evaluate("location.hash").startswith("#/playlist/"))
        shot(page, "09b-import-done")

        # clean up via API
        import json as _json
        import urllib.request as _url
        pid = page.evaluate("location.hash.split('/')[2].split('?')[0]")
        for _ in range(3):  # dev-VM I/O can stall a write briefly — cleanup must not fail the suite
            try:
                _url.urlopen(_url.Request(f"{BASE}/api/playlists/{pid}", method="DELETE"), timeout=30).read()
                break
            except Exception:
                time.sleep(1)


        # ── settings: themes & accent ─────────────────────────
        page.click("#btn-settings")
        page.wait_for_selector("#st-themes", timeout=8000)
        time.sleep(0.6)
        shot(page, "10-settings-dark")

        # violet accent
        page.click("#st-accents .chip >> nth=1")
        time.sleep(0.9)
        shot(page, "11-settings-violet")

        # light theme
        page.click("#st-themes .chip >> nth=2")
        time.sleep(1.2)
        check("theme: light applied", page.evaluate("document.documentElement.dataset.theme") == "light")
        shot(page, "12-light")
        page.goto(BASE + "/#/home", wait_until="networkidle")
        time.sleep(1.5)
        shot(page, "13-light-home")

        # midnight
        page.evaluate("localStorage.setItem('osmp.theme', '\"midnight\"')")
        page.reload(wait_until="load")
        time.sleep(1.5)
        check("theme: midnight persisted", page.evaluate("document.documentElement.dataset.theme") == "midnight")
        shot(page, "14-midnight-home")

        # back to dark for later screenshots
        page.evaluate("localStorage.setItem('osmp.theme', '\"dark\"'); localStorage.setItem('osmp.accent', '178')")
        page.reload(wait_until="load")
        time.sleep(1)

        # ── v0.3.0: stats view ────────────────────────────────
        page.goto(BASE + "/#/stats")
        time.sleep(2.2)
        check("stats: view renders", "plays" in (page.text_content("#view-root") or "").lower())
        check("stats: charts drawn", page.locator(".chart-svg").count() >= 2)
        check("stats: ranked rows", page.locator(".rank-row").count() >= 1)
        # range chip re-renders without errors
        page.locator("#st-ranges .chip >> nth=0").click()
        time.sleep(1.4)
        check("stats: range switch works", page.locator(".chart-svg").count() >= 2)
        shot(page, "16-stats")

        # ── v0.3.0: artist page ───────────────────────────────
        page.goto(BASE + "/#/library")
        time.sleep(2)
        chips = page.locator("#lb-artists .artist-chip")
        check("library: artist chips", chips.count() >= 1)
        if chips.count():
            chips.first.click()
            time.sleep(1.6)
            check("artist: page opens", page.evaluate("location.hash").startswith("#/artist/"))
            check("artist: tracklist", page.locator(".tl-row").count() >= 1)
            shot(page, "17-artist")

        # ── v0.4.0: upload your own music ────────────────────
        import os as _os
        import subprocess as _sp
        import tempfile as _tf
        _ff = _os.path.expanduser("~/tools/ffmpeg/bin/ffmpeg")
        if _os.path.isfile(_ff):
            _updir = _tf.mkdtemp()
            _upfile = _os.path.join(_updir, "ui upload test.mp3")
            _sp.run([_ff, "-y", "-loglevel", "error", "-f", "lavfi",
                     "-i", "sine=frequency=330:duration=2",
                     "-metadata", "title=UI Upload Test",
                     "-metadata", "artist=UI Tester", _upfile],
                    check=True, timeout=60)
            page.goto(BASE + "/#/library")
            time.sleep(1.6)
            page.set_input_files("#lb-file", [_upfile])
            time.sleep(4)
            lib_titles = page.locator("#lb-downloads .tl-title").all_text_contents()
            check("upload: appears in library", "UI Upload Test" in lib_titles)
            shot(page, "22-upload-library")
            page.goto(BASE + "/#/search")
            time.sleep(1.0)
            page.fill("#sr-input", "UI Upload Test")
            page.keyboard.press("Enter")
            time.sleep(3.5)
            check("upload: searchable as library match",
                  "UI Upload Test" in (page.locator("#sr-mine").text_content() or ""))
            cleaned = page.evaluate("""async () => {
              const lib = await (await fetch('/api/library?offline_only=true',
                {credentials:'same-origin'})).json();
              const t = lib.tracks.find(x => x.title === 'UI Upload Test');
              if (!t) return false;
              await fetch('/api/library/' + encodeURIComponent(t.id),
                {method:'DELETE', credentials:'same-origin'});
              return true;
            }""")
            check("upload: cleanup via API", cleaned)
            # leave the search input so single-key shortcuts work again
            page.goto(BASE + "/#/library")
            time.sleep(1.0)
        else:
            print("  (ffmpeg not found — skipping upload UI test)")

        # ── v0.5.0: smart playlists ──────────────────────────
        page.goto(BASE + "/#/library")
        time.sleep(1.6)
        check("smart: library section renders",
              page.locator("#lb-smart-sec").count() == 1)
        page.click("#lb-new-smart")
        time.sleep(1.2)
        check("smart: editor opens", page.locator("#sm-ed-name").count() == 1)
        page.fill("#sm-ed-name", "UI Smart Test")
        preset_chips = page.locator("#sm-ed-presets .chip")
        check("smart: preset chips offered", preset_chips.count() >= 3)
        preset_chips.first.click()  # Most played
        time.sleep(0.4)
        page.click("#sm-ed-addrule")
        time.sleep(0.6)  # debounce + preview round-trip
        preview_txt = page.text_content("#sm-ed-preview") or ""
        check("smart: live preview counts tracks",
              "track" in preview_txt and any(c.isdigit() for c in preview_txt),
              preview_txt.strip())
        shot(page, "23-smart-editor")
        page.click("#sm-ed-save")
        page.wait_for_selector("#sm-list", timeout=6000)
        check("smart: detail view after save",
              page.evaluate("location.hash").startswith("#/smart/")
              and "Smart playlist" in (page.text_content(".detail-kind") or ""))
        check("smart: evaluated tracklist", page.locator("#sm-list .tl-row").count() >= 1)
        shot(page, "24-smart-detail")
        # edit: switch preset to Deeper cuts and save
        page.click("#sm-edit")
        time.sleep(1.0)
        page.fill("#sm-ed-name", "UI Smart Test 2")
        deeper = page.locator("#sm-ed-presets .chip", has_text="Deeper cuts")
        if deeper.count():
            deeper.first.click()
        page.click("#sm-ed-save")
        page.wait_for_selector("#sm-list", timeout=6000)
        check("smart: edit persists",
              "UI Smart Test 2" in (page.text_content("#sm-name") or ""))
        # play from the smart list (queue gets populated)
        page.click("#sm-play")
        time.sleep(1.5)
        check("smart: play fills queue", page.locator("#pb-play").count() == 1
              and page.evaluate("!document.getElementById('player-bar').classList.contains('hidden')"))
        # delete it
        page.click("#sm-delete")
        page.wait_for_selector(".modal", timeout=5000)
        page.click('.modal [data-act="ok"]')
        time.sleep(1.2)
        check("smart: delete returns to library",
              page.evaluate("location.hash").startswith("#/library"))

        # ── v0.7.0: per-user playlists & share dialog ────────
        page.goto(BASE + "/#/library")
        time.sleep(1.6)
        page.locator(".pl-item").first.click()
        time.sleep(1.5)
        check("sharing: owner sees Share button", page.locator("#pl-share").count() == 1)
        check("sharing: owner sees rename/delete",
              page.locator("#pl-rename").count() == 1 and page.locator("#pl-delete").count() == 1)
        page.click("#pl-share")
        page.wait_for_selector(".modal", timeout=5000)
        check("sharing: dialog has account picker + editor",
              page.locator(".modal select").count() >= 1
              and page.locator(".modal [data-act=\"save\"]").count() == 1)
        shot(page, "25-share-dialog")
        page.click('.modal [data-act="cancel"]')
        time.sleep(0.5)

        # ── v0.3.0: lyrics (needs the playing track from earlier) ──
        page.keyboard.press("l")
        page.wait_for_selector("#lyrics-overlay:not(.hidden)", timeout=5000)
        time.sleep(3.5)
        lrows = page.locator(".ly-line").count()
        if lrows > 5:  # a lyric hit — check the synced highlight machinery
            page.evaluate("document.getElementById('audio-el').currentTime = 45")
            time.sleep(1.8)
            check("lyrics: synced highlight", page.locator(".ly-line.active").count() == 1)
            shot(page, "18-lyrics")
        else:
            shot(page, "18-lyrics-miss")  # graceful miss is also a valid state
        page.keyboard.press("Escape")
        time.sleep(0.4)

        # ── v0.3.0: shuffle honors the clicked row ────────────
        page.goto(BASE + "/#/search")
        page.fill("#sr-input", "never gonna give you up")
        page.keyboard.press("Enter")
        time.sleep(4)
        page.click("#pb-shuffle")  # on
        time.sleep(0.4)
        page.locator(".tl-row").nth(3).click()
        time.sleep(2.2)
        clicked = (page.locator(".tl-row").nth(3).locator(".tl-title").text_content() or "").strip()
        playing = (page.text_content("#pb-title") or "").strip()
        check("shuffle: clicked track plays first", clicked == playing,
              f"clicked {clicked!r} playing {playing!r}")
        page.click("#pb-shuffle")  # off

        # ── v0.3.0: equalizer + backup cards in settings ──────
        page.goto(BASE + "/#/settings")
        time.sleep(1.6)
        check("eq: three band sliders", page.locator(".eq-band input[type=range]").count() == 3)
        page.locator('.eq-band input[data-band="bass"]').fill("6")
        time.sleep(0.3)
        check("eq: custom preset detected",
              (page.locator("#st-eq-presets .chip.on").text_content() or "").strip() == "Custom")
        check("backup: export card (admin)", page.locator("#st-backup-export").is_visible())
        shot(page, "19-settings-eq")

        # ── v0.3.0: playback speed + queue clear-upcoming ─────
        page.click("#pb-cover-btn")
        time.sleep(0.7)
        page.click("#np-speed")
        time.sleep(0.4)
        check("speed: chip cycles", "1.25×" in (page.text_content("#np-speed-label") or ""))
        check("speed: rate applied",
              abs(page.evaluate("document.getElementById('audio-el').playbackRate") - 1.25) < 0.01)
        page.keyboard.press(",")
        time.sleep(0.3)
        check("speed: reset key restores 1×",
              "1×" in (page.text_content("#np-speed-label") or ""))
        page.click("#np-close")
        time.sleep(0.5)
        page.evaluate("window._osmpOpenDrawer()")
        time.sleep(0.5)
        check("queue: clear-upcoming present", page.locator("#qd-clear-upcoming").count() == 1)
        page.evaluate("window._osmpCloseDrawer()")

        # ── v0.3.0: history view ──────────────────────────────
        page.goto(BASE + "/#/history")
        time.sleep(2.2)
        check("history: journal renders", page.locator(".rank-row").count() >= 1)
        check("history: grouped by day", page.locator("#hy-body .section").count() >= 1)
        shot(page, "20-history")

        # ── v0.3.0: made-for-you + EQ bypass + visualizer ────
        page.goto(BASE + "/#/home")
        time.sleep(2.2)
        foryou = page.locator("#hm-foryou .card")
        check("home: made-for-you shelf", foryou.count() >= 1)
        shot(page, "21-made-for-you")

        page.goto(BASE + "/#/settings")
        time.sleep(1.4)
        check("eq: bypass checkbox", page.locator("#st-eq-bypass").count() == 1)
        page.uncheck("#st-eq-bypass")
        time.sleep(0.4)
        page.check("#st-eq-bypass")
        time.sleep(0.4)

        page.click("#pb-cover-btn")
        time.sleep(0.7)
        page.click("#np-viz")
        time.sleep(1.2)
        check("viz: canvas appears", page.locator("#np-viz-canvas:not(.hidden)").count() == 1)
        page.click("#np-viz")
        page.keyboard.press("?")
        time.sleep(0.5)
        check("kb: help overlay", "Keyboard shortcuts" in (page.text_content("#modal-host") or ""))
        page.keyboard.press("Escape")
        page.click("#np-close")

        # radio surprise button
        page.goto(BASE + "/#/radio")
        time.sleep(1.2)
        check("radio: surprise button", page.locator("#rd-surprise").count() == 1)

        # ── mobile viewport pass (v0.7.3): layout + touch behavior ──
        mctx = browser.new_context(viewport={"width": 390, "height": 844},
                                   device_scale_factor=2, has_touch=True)
        mp = mctx.new_page()
        mp.on("console", lambda m: console_errors.append(m.text)
              if m.type == "error" else None)
        mp.on("pageerror", lambda e: console_errors.append(str(e)))
        mp.goto(BASE, wait_until="load", timeout=30000)
        mp.wait_for_selector("#auth-form", state="visible", timeout=15000)
        mp.fill("#auth-user", "admin")
        mp.fill("#auth-pass", "osmp-admin")
        mp.click("#auth-go")
        mp.wait_for_selector("#app:not(.hidden)", timeout=20000)
        time.sleep(1.2)

        # no horizontal overflow on the main views at phone width
        for h, wait in [("#/home", 1.5), ("#/library", 1.8), ("#/settings", 1.2)]:
            mp.evaluate(f"location.hash='{h}'")
            time.sleep(wait)
            o = mp.evaluate("""() => ({
                doc: document.documentElement.scrollWidth, win: window.innerWidth,
                root: document.getElementById('view-root').scrollWidth,
                rootClient: document.getElementById('view-root').clientWidth })""")
            check(f"mobile{h}: no horizontal overflow",
                  o["doc"] <= o["win"] + 1 and o["root"] <= o["rootClient"] + 1,
                  f"doc={o['doc']} win={o['win']} root={o['root']}/{o['rootClient']}")

        # the top bar fits: settings gear inside the viewport and visible
        gear = mp.evaluate("""() => {
            const ico = document.querySelector('#btn-settings .nav-ico');
            const r = ico.getBoundingClientRect();
            return { display: getComputedStyle(ico).display, right: Math.round(r.right),
                     win: window.innerWidth };
        }""")
        check("mobile: settings gear visible and inside the bar",
              gear["display"] != "none" and gear["right"] <= gear["win"], str(gear))

        # account chip is hidden on phones → Settings must offer sign-out
        mp.evaluate("location.hash='#/settings'")
        mp.wait_for_selector("#st-signout", timeout=10000)
        me_txt = (mp.text_content("#st-me-name") or "").strip()
        check("mobile: Settings shows signed-in account + sign out",
              bool(me_txt) and me_txt != "…", me_txt)
        shot(mp, "m1-settings-account")

        # the reported bug: with shuffle on, tapping a track row (center —
        # where the artist link used to hijack the tap) plays THAT track
        mp.evaluate("location.hash='#/search'")
        mp.wait_for_selector("#sr-input", timeout=8000)
        mp.fill("#sr-input", "daft punk get lucky")
        mp.keyboard.press("Enter")
        mp.wait_for_selector(".tl-row", timeout=30000)
        time.sleep(0.6)
        if "on" not in (mp.get_attribute("#pb-shuffle", "class") or ""):
            mp.click("#pb-shuffle")
            time.sleep(0.3)
        want = (mp.locator(".tl-row").nth(1).locator(".tl-title").text_content() or "").strip()
        mp.locator(".tl-row").nth(1).click()  # row center, not the title specifically
        time.sleep(1.8)
        got = (mp.text_content("#pb-title") or "").strip()
        check("mobile: shuffle on → tapping a row plays that track",
              bool(want) and (want in got or got in want), f"want={want!r} got={got!r}")
        bar_title = mp.evaluate("""() => Math.round(
            document.getElementById('pb-title').getBoundingClientRect().width)""")
        check("mobile: player bar shows the track title", bar_title > 40, f"w={bar_title}")
        shot(mp, "m2-player-bar")

        # hover-only affordances must be visible on touch
        afford = mp.evaluate("""() => ({
            dl: getComputedStyle(document.querySelector('.tl-row .tl-actions')).opacity,
            x: (() => { const q = document.querySelector('.qd-item .qd-x');
                        return q ? getComputedStyle(q).opacity : 'missing'; })(),
        })""")
        check("mobile: per-row download + queue remove visible without hover",
              afford["dl"] == "1" and afford["x"] in ("1", "missing"), str(afford))
        mctx.close()

        # ── home with playback history ────────────────────────
        page.goto(BASE + "/#/home")
        time.sleep(1.8)
        shot(page, "15-home-final")

        # ── console errors ────────────────────────────────────
        # Resource-level 404s are expected by design (maxres→hq thumbnail
        # fallback chain); real JS exceptions arrive via pageerror.
        real_errors = [e for e in console_errors
                       if "favicon" not in e.lower()
                       and not e.startswith("Failed to load resource")]
        check("console: no fatal JS errors", not real_errors, "; ".join(real_errors[:5]))

        browser.close()

    print("\n" + "═" * 52)
    print(f"PASSED {len(PASS)}   FAILED {len(FAIL)}")
    if FAIL:
        print("Failed checks:")
        for f in FAIL:
            print("  ✗", f)
    print("═" * 52)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
