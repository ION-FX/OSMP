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

        # ── boot ──────────────────────────────────────────────
        page.goto(BASE, wait_until="networkidle", timeout=30000)
        page.wait_for_selector("#boot-splash.done, #boot-splash:removed", timeout=15000) \
            if page.locator("#boot-splash").count() else None
        page.wait_for_selector("#app:not(.hidden)", timeout=15000)
        time.sleep(1.2)
        check("boot: app visible", page.is_visible("#app"))
        shot(page, "01-home")

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

        # ── controls ──────────────────────────────────────────
        page.click("#pb-play")  # pause
        time.sleep(0.4)
        paused = page.evaluate("document.getElementById('audio-el').paused")
        check("controls: pause works", paused)
        page.click("#pb-play")  # resume
        time.sleep(0.4)
        check("controls: resume works", not page.evaluate("document.getElementById('audio-el').paused"))

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

        # ── home with playback history ────────────────────────
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
