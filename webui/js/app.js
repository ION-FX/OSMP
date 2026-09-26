// OSMP boot — config fetch, PIN gate, module init, service worker, connectivity.

import { api, setUnauthorizedHandler } from './api.js';
import { get, set, sub, load, persist } from './store.js';
import { initTheme } from './theme.js';
import { hydrateIcons } from './components/icons.js';
import { toast, toastOk, toastErr } from './components/toast.js';
import { initPlayer } from './player.js';
import { initActions, refreshPlaylists, refreshPlaylistsDeep } from './actions.js';
import { initRouter } from './router.js';

const $ = (id) => document.getElementById(id);

// Thumbnail fallback chain: maxres (16:9, no letterbox bars) → hq → mq → hide.
// YouTube only ships maxres for some uploads, so every <img> degrades gracefully.
window.__thumbErr = (el) => {
  const src = el.src || '';
  if (src.includes('maxresdefault')) el.src = src.replace('maxresdefault', 'hqdefault');
  else if (src.includes('hqdefault')) el.src = src.replace('hqdefault', 'mqdefault');
  else el.style.visibility = 'hidden';
};

async function boot() {
  initTheme();
  hydrateIcons();

  // PIN gate handler (shared by boot + api 401s)
  setUnauthorizedHandler(showPinGate);

  let cfg = null;
  try {
    cfg = await api.config();
  } catch (e) {
    // server unreachable — still boot UI from service-worker cache if present
    cfg = { version: '?', auth_required: false, llm_configured: false, ffmpeg: false };
    setOnline(false);
  }
  set({ config: cfg }, false);

  if (cfg.auth_required) {
    const ok = await showPinGate();
    if (!ok) return; // stays locked
  }

  initPlayer();
  initActions();
  wireGlobalUi();

  try {
    await refreshPlaylistsDeep();
  } catch (e) { console.warn('[app] playlists unavailable', e); }

  initRouter();
  registerSw();
  startConnectivityWatch();

  // hide splash
  requestAnimationFrame(() => {
    $('boot-splash').classList.add('done');
    $('app').classList.remove('hidden');
    $('player-bar').classList.add('hidden');
    setTimeout(() => $('boot-splash').remove(), 600);
  });

  console.log('%c OSMP ', 'background:linear-gradient(115deg,#0fb8ad,#8b5cf6);color:#fff;font-weight:bold;border-radius:4px',
    `v${cfg.version} — self-hosted & happy`);
}

// ── PIN gate ─────────────────────────────────────────────────────────

function showPinGate() {
  return new Promise(resolve => {
    const ov = $('pin-overlay');
    ov.classList.remove('hidden');
    const form = $('pin-form');
    const input = $('pin-input');
    const err = $('pin-error');
    err.classList.add('hidden');
    setTimeout(() => input.focus(), 80);

    const handler = async (e) => {
      e.preventDefault();
      const pin = input.value;
      try {
        await api.auth(pin);
        ov.classList.add('hidden');
        form.removeEventListener('submit', handler);
        resolve(true);
      } catch (ex) {
        err.classList.remove('hidden');
        input.value = '';
        input.focus();
        // re-trigger shake
        err.style.animation = 'none';
        void err.offsetWidth;
        err.style.animation = '';
      }
    };
    form.addEventListener('submit', handler);
  });
}

// ── global UI wiring ─────────────────────────────────────────────────

function wireGlobalUi() {
  $('btn-settings').onclick = () => { location.hash = '#/settings'; };

  // online/offline pill (server reachability, not just browser offline)
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('online', () => setOnline(true));
}

let watchT = null;
function startConnectivityWatch() {
  const ping = async () => {
    try {
      await api.health();
      setOnline(true);
    } catch {
      setOnline(navigator.onLine === false ? false : get('online'));
      // if browser thinks we're online but server is gone, mark offline
      if (navigator.onLine) {
        try { await api.health(); setOnline(true); } catch { setOnline(false); }
      }
    }
  };
  ping();
  watchT = setInterval(ping, 20000);
}

function setOnline(on) {
  const was = get('online');
  set({ online: on }, false);
  $('offline-pill')?.classList.toggle('hidden', on);
  if (was && !on) toast('Server unreachable — downloaded tracks still play', { icon: 'cloud-off', timeout: 5000 });
}

// ── service worker (PWA) ─────────────────────────────────────────────

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    return; // SW needs a secure context
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[app] SW registration failed', err);
    });
  });
}

boot().catch(err => {
  console.error('[app] boot failed', err);
  const splash = $('boot-splash');
  if (splash) {
    splash.innerHTML = `
      <div style="text-align:center;padding:30px;max-width:420px">
        <h2 style="margin-bottom:10px">OSMP failed to start</h2>
        <p class="dim" style="font-size:13px;margin-bottom:18px">${String(err.message || err)}</p>
        <button class="btn primary" onclick="location.reload()">Retry</button>
      </div>`;
  }
});
