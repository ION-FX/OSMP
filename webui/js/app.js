// OSMP boot — config fetch, auth gate (login / first-run setup), module init,
// service worker, connectivity + offline sync.

import { api, setUnauthorizedHandler, outboxCount, outboxFlush } from './api.js';
import { get, set, sub, load, persist } from './store.js';
import { initTheme } from './theme.js';
import { hydrateIcons } from './components/icons.js';
import { toast, toastOk, toastErr } from './components/toast.js';
import { initPlayer } from './player.js';
import { initActions, refreshPlaylists, refreshPlaylistsDeep } from './actions.js';
import { initLyrics } from './lyrics.js';
import { initVisualizer } from './visualizer.js';
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

  // auth gate handler (shared by boot + api 401s)
  setUnauthorizedHandler(() => showAuthGate('login'));

  let cfg = null;
  try {
    cfg = await api.config();
  } catch (e) {
    // server unreachable — still boot UI from service-worker cache if present
    cfg = { version: '?', auth_required: false, llm_configured: false, ffmpeg: false, user: null };
    setOnline(false);
  }
  set({ config: cfg }, false);

  if (cfg.setup_required) {
    const ok = await showAuthGate('setup');
    if (!ok) return;
  } else if (cfg.auth_required) {
    const ok = await showAuthGate('login');
    if (!ok) return; // stays locked
  }

  initPlayer();
  initActions();
  initLyrics();
  initVisualizer();
  wireGlobalUi();
  renderUserChip(cfg.user || await safeMe());

  try {
    await refreshPlaylistsDeep();
  } catch (e) { console.warn('[app] playlists unavailable', e); }

  initRouter();
  registerSw();
  startConnectivityWatch();

  // hide splash (already gone if the auth gate showed first)
  requestAnimationFrame(() => {
    $('boot-splash')?.classList.add('done');
    $('app').classList.remove('hidden');
    // keep the bar when a previous session was restored into it
    if (!get('current')) $('player-bar').classList.add('hidden');
    setTimeout(() => $('boot-splash')?.remove(), 600);
  });

  console.log('%c OSMP ', 'background:linear-gradient(115deg,#0fb8ad,#8b5cf6);color:#fff;font-weight:bold;border-radius:4px',
    `v${cfg.version} — self-hosted & happy`);
}

async function safeMe() {
  try { return (await api.me()).user; } catch { return null; }
}

// ── auth gate (login / first-run admin setup) ────────────────────────

function showAuthGate(mode) {
  return new Promise(resolve => {
    const ov = $('pin-overlay');
    const form = $('auth-form');
    const userInput = $('auth-user');
    const passInput = $('auth-pass');
    const nameInput = $('auth-name');
    const err = $('pin-error');
    const go = $('auth-go');

    // the boot splash sits above everything — the gate replaces it visually
    $('boot-splash')?.classList.add('done');
    setTimeout(() => $('boot-splash')?.remove(), 600);

    const isSetup = mode === 'setup';
    $('auth-logo').textContent = isSetup ? '🎧' : '🔒';
    $('auth-title').textContent = isSetup ? 'Set up your server' : 'Sign in';
    $('auth-sub').textContent = isSetup
      ? 'Create the admin account — you can invite others later in Settings'
      : 'to this OSMP server';
    nameInput.classList.toggle('hidden', !isSetup);
    go.textContent = isSetup ? 'Create admin account' : 'Sign in';
    err.classList.add('hidden');
    ov.classList.remove('hidden');
    setTimeout(() => (isSetup ? userInput : passInput).focus(), 80);

    form.onsubmit = async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        const cfg = isSetup
          ? await api.setup(userInput.value.trim(), passInput.value, nameInput.value.trim())
          : await api.login(userInput.value.trim(), passInput.value);
        set({ config: { ...(get('config') || {}), user: cfg.user, auth_required: false, setup_required: false } }, false);
        ov.classList.add('hidden');
        form.onsubmit = null;
        renderUserChip(cfg.user);
        resolve(true);
      } catch (ex) {
        err.textContent = isSetup
          ? (ex.detail || 'Could not create the account')
          : (ex.status === 0 ? 'Server unreachable' : 'Wrong username or password');
        err.classList.remove('hidden');
        passInput.value = '';
        passInput.focus();
        err.style.animation = 'none';
        void err.offsetWidth;
        err.style.animation = '';
      } finally {
        go.disabled = false;
      }
    };
  });
}

function renderUserChip(user) {
  const chip = $('btn-user');
  if (!user) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  $('user-name').textContent = user.name + (user.role === 'admin' ? ' · admin' : '');
  $('btn-logout').onclick = async (e) => {
    e.stopPropagation();
    try {
      await api.logout();
      location.reload();
    } catch { toastErr('Sign out failed'); }
  };
  chip.title = `${user.name} (${user.role})`;
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
      setOnline(false);
    }
  };
  ping();
  watchT = setInterval(ping, 20000);
}

function setOnline(on) {
  const was = get('online');
  set({ online: on }, false);
  $('offline-pill')?.classList.toggle('hidden', on);
  if (was && !on) toast('Offline — saved tracks still play, changes will sync', { icon: 'cloud-off', timeout: 5000 });
  if (!was && on) {
    // back online: flush everything the user did while offline
    const pending = outboxCount();
    if (pending > 0) {
      outboxFlush().then(synced => {
        if (synced > 0) toastOk(`Synced ${synced} offline change${synced === 1 ? '' : 's'}`, { icon: 'check' });
        if (synced > 0) refreshPlaylistsDeep().catch(() => {});
      });
    }
    // refresh stale views (playlists changed elsewhere may exist too)
    refreshPlaylists().catch(() => {});
  }
}

// ── service worker (PWA) ─────────────────────────────────────────────

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    return; // SW needs a secure context
  }
  const doRegister = () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[app] SW registration failed', err);
    });
  };
  // the auth gate can hold boot past the load event — register right away then
  if (document.readyState === 'complete') doRegister();
  else window.addEventListener('load', doRegister);
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
