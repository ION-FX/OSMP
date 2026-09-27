// Shared track actions: download (server + Android-native), add-to-playlist
// dialog, context menu, sleep-timer dialog, like handling.

import { api, streamUrl, thumbUrl, fmtTime } from './api.js';
import { get, set, sub, load, markOffline, rememberTracks, persist } from './store.js';
import { icon, hydrateIcons } from './components/icons.js';
import { toast, toastOk, toastErr } from './components/toast.js';
import { customDialog, promptDialog } from './components/dialog.js';
import { bridge } from './player.js';
import { updateLikeButtons } from './player.js';

// ── playlists state refresh ──────────────────────────────────────────

export async function refreshPlaylists() {
  try {
    const { playlists } = await api.playlists();
    set({ playlists });
    renderSidebarPlaylists();
  } catch (e) {
    console.warn('[actions] playlist refresh failed', e);
  }
}

export async function refreshPlaylistsDeep() {
  // includes track ids per playlist (for like state); used sparingly
  try {
    const { playlists } = await api.playlists();
    for (const p of playlists) {
      const full = await api.playlist(p.id);
      p.trackIds = full.tracks.map(t => t.id);
    }
    set({ playlists });
    renderSidebarPlaylists();
    updateLikeButtons();
  } catch (e) {
    console.warn('[actions] deep playlist refresh failed', e);
  }
}

export function renderSidebarPlaylists() {
  const host = document.getElementById('sidebar-playlists');
  if (!host) return;
  const pls = get('playlists');
  if (!pls.length) {
    host.innerHTML = `<div class="faint" style="padding:10px 12px;font-size:12.5px">No playlists yet</div>`;
    return;
  }
  host.innerHTML = '';
  pls.forEach(p => {
    const a = document.createElement('a');
    a.className = 'pl-item';
    a.href = `#/playlist/${p.id}`;
    a.innerHTML = `<span class="pl-ico">${icon(p.name === 'Liked' ? 'heart' : 'music', 16, p.name === 'Liked')}</span><span class="pl-name"></span>`;
    a.querySelector('.pl-name').textContent = p.name;
    if (get('route').name === 'playlist' && String(get('route').params.id) === String(p.id)) {
      a.classList.add('active');
    }
    host.appendChild(a);
  });
}

// ── like (Favorites) ─────────────────────────────────────────────────

export async function ensureLikedPlaylist() {
  let liked = get('playlists').find(p => p.name === 'Liked');
  if (!liked) {
    liked = await api.createPlaylist('Liked', 'Tracks you hearted', 'user');
    liked.trackIds = [];
    await refreshPlaylists();
    liked = get('playlists').find(p => p.name === 'Liked');
  }
  return liked;
}

export async function toggleLike(track) {
  if (!track) return;
  try {
    const liked = await ensureLikedPlaylist();
    // offline: trust the cached track ids (deep refresh) so the like still
    // lands — the mutation itself is journaled and replays on reconnect
    const offline = get('online') === false;
    if (!offline) {
      const full = await api.playlist(liked.id);
      liked.trackIds = full.tracks.map(t => t.id);
    }
    const ids = liked.trackIds || [];
    if (ids.includes(track.id)) {
      await api.removeFromPlaylist(liked.id, track.id);
      liked.trackIds = ids.filter(i => i !== track.id);
      toast('Removed from Liked', { icon: 'heart' });
    } else {
      await api.addToPlaylist(liked.id, [{
        id: track.id, title: track.title, artist: track.artist,
        duration: track.duration, thumbnail: track.thumbnail,
      }]);
      liked.trackIds = [...ids, track.id];
      toastOk('Saved to Liked', { icon: 'heart' });
    }
    if (offline) {
      renderSidebarPlaylists();
      updateLikeButtons();
    } else {
      await refreshPlaylistsDeep();
    }
  } catch (e) {
    toastErr(e.detail || e.message || 'Like failed');
  }
}

// ── downloads ────────────────────────────────────────────────────────

const nativePolls = new Map(); // id -> interval

export function downloadTrack(track, buttonEl = null) {
  const b = bridge();
  if (b && b.downloadTrack) {
    // Android: native on-device download
    try {
      b.downloadTrack(track.id, streamUrl({ ...track, offline: false }), track.title || '', track.artist || '');
      toast(`Downloading to device — ${track.title}`, { icon: 'download' });
      pollNative(track.id, buttonEl);
    } catch (e) {
      toastErr('Native download failed');
    }
    return;
  }
  serverDownload(track, buttonEl);
}

async function serverDownload(track, buttonEl) {
  const existing = get('downloads').get(track.id);
  if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
    toast('Already downloading…', { icon: 'download' });
    return;
  }
  setProgress(track.id, { status: 'queued', progress: 0 });
  if (buttonEl) decorateButton(buttonEl, track.id);
  try {
    const res = await api.download(track.id, track.title, track.artist);
    if (res.already) {
      markOffline(track.id, true);
      setProgress(track.id, { status: 'done', progress: 1 });
      toastOk('Already in your library', { icon: 'download-check' });
      return;
    }
    pollServerJob(res.job_id, track, buttonEl);
  } catch (e) {
    setProgress(track.id, { status: 'error' });
    toastErr(e.detail || 'Download failed');
  }
}

function pollServerJob(jobId, track, buttonEl) {
  const tick = setInterval(async () => {
    try {
      const job = await api.jobStatus(jobId);
      setProgress(track.id, { status: job.status, progress: job.progress || 0 });
      if (job.status === 'done') {
        clearInterval(tick);
        markOffline(track.id, true);
        toastOk(`Downloaded — ${track.title}`, { icon: 'download-check' });
      } else if (job.status === 'error') {
        clearInterval(tick);
        toastErr(`Download failed: ${job.error || 'unknown error'}`);
      }
    } catch (e) {
      clearInterval(tick);
      setProgress(track.id, { status: 'error' });
      toastErr('Lost track of the download job');
    }
  }, 800);
}

function pollNative(trackId, buttonEl) {
  if (nativePolls.has(trackId)) return;
  setProgress(trackId, { status: 'downloading', progress: 0 });
  const tick = setInterval(() => {
    const b = bridge();
    let st = null;
    try { st = JSON.parse(b?.getDownloadState?.(trackId) || 'null'); } catch { /* */ }
    if (!st) return;
    setProgress(trackId, { status: st.status, progress: st.progress || 0 });
    if (st.status === 'done') {
      clearInterval(tick); nativePolls.delete(trackId);
      markOffline(trackId, true);
      toastOk('Saved on device', { icon: 'download-check' });
    } else if (st.status === 'error') {
      clearInterval(tick); nativePolls.delete(trackId);
      toastErr('Device download failed');
    }
  }, 800);
  nativePolls.set(trackId, tick);
}

function setProgress(trackId, state) {
  const d = new Map(get('downloads'));
  d.set(trackId, state);
  set({ downloads: d });
  updateDownloadButtons(trackId);
}

export function decorateButton(btn, trackId) {
  btn.dataset.dlTrack = trackId;
}

export function updateDownloadButtons(trackId) {
  const st = get('downloads').get(trackId);
  document.querySelectorAll(`[data-dl-track="${trackId}"]`).forEach(btn => {
    let ring = btn.querySelector('.dl-ring');
    if (st && (st.status === 'downloading' || st.status === 'queued' || st.status === 'processing')) {
      btn.classList.add('on');
      if (!ring) {
        ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ring.setAttribute('class', 'dl-ring');
        ring.setAttribute('viewBox', '0 0 32 32');
        ring.innerHTML = '<circle cx="16" cy="16" r="14"/>';
        btn.appendChild(ring);
      }
      const circ = 2 * Math.PI * 14;
      const off = circ * (1 - (st.progress || 0));
      ring.querySelector('circle').style.strokeDasharray = String(circ);
      ring.querySelector('circle').style.strokeDashoffset = String(off);
    } else {
      ring?.remove();
      btn.classList.remove('on');
    }
  });
}

export async function removeDownload(track, buttonEl = null) {
  const b = bridge();
  try {
    if (b && b.isDownloaded && b.isDownloaded(track.id)) {
      b.deleteDownload(track.id);
    } else {
      await api.removeDownload(track.id);
    }
    markOffline(track.id, false);
    toast('Removed from downloads', { icon: 'trash' });
  } catch (e) {
    toastErr(e.detail || 'Remove failed');
  }
}

export function isTrackOffline(track) {
  if (!track) return false;
  const b = bridge();
  try { if (b && b.isDownloaded && b.isDownloaded(track.id)) return true; } catch { /* */ }
  if (deviceOfflineIds().includes(track.id)) return true;
  return !!track.offline;
}

// ── device offline (browser/desktop clients, Cache API) ──────────────
// Server downloads live on the OSMP machine; "Save to this device" pulls the
// audio into this browser's Cache so it plays with the server unreachable.
// The service worker serves osmp-audio-v1 when the network is down.

export const AUDIO_CACHE = 'osmp-audio-v1';
const DEV_KEY = 'deviceOffline';

export function deviceOfflineIds() {
  return load(DEV_KEY, []);
}

function deviceSourceUrl(track) {
  return track.offline
    ? `/api/library/stream/${encodeURIComponent(track.id)}`
    : `/api/stream/${encodeURIComponent(track.id)}?fmt=${localStorage.getItem('osmp.format') || 'auto'}`;
}

export async function saveToDevice(track) {
  if (!('caches' in window)) { toastErr("This browser can't store offline audio"); return; }
  if (isDeviceOffline(track)) { toast('Already saved on this device', { icon: 'download-check' }); return; }
  toast(`Saving offline…`, { icon: 'download', timeout: 2500 });
  // osmpsave=1 bypasses the service worker so the page owns this fetch and
  // the stream lands in the cache exactly once
  const base = deviceSourceUrl(track);
  const url = base + (base.includes('?') ? '&' : '?') + 'osmpsave=1';
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 120000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(base, resp);  // stored under the player-facing URL
    persist(DEV_KEY, [...deviceOfflineIds(), track.id]);
    toastOk(`Saved offline — ${track.title}`, { icon: 'download-check' });
    import('./player.js').then(p => p.refreshOfflineState?.(track.id));
  } catch (e) {
    toastErr(e.status === 0 || e.name === 'AbortError'
      ? 'Need the server once to save' : 'Save failed');
  } finally {
    clearTimeout(kill);
  }
}

export function isDeviceOffline(track) {
  return !!track && deviceOfflineIds().includes(track.id);
}

export async function removeDeviceOffline(track) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const target = new URL(deviceSourceUrl(track), location.origin).pathname;
    const keys = await cache.keys();
    await Promise.all(keys
      .filter(k => new URL(k.url).pathname === target)
      .map(k => cache.delete(k)));
  } catch { /* cache unavailable — still drop the flag */ }
  persist(DEV_KEY, deviceOfflineIds().filter(id => id !== track.id));
  toast('Removed from this device', { icon: 'trash' });
  import('./player.js').then(p => p.refreshOfflineState?.(track.id));
}

// ── add to playlist dialog ───────────────────────────────────────────

export function addToPlaylistDialog(tracks) {
  const list = Array.isArray(tracks) ? tracks : [tracks];
  refreshPlaylists().then(() => {
    const pls = get('playlists');
    const items = pls.map(p => `
      <div class="modal-item" data-pid="${p.id}">
        <span style="color:var(--accent-bright);display:flex">${icon(p.name === 'Liked' ? 'heart' : 'music', 18)}</span>
        <span class="grow ellipsis"></span>
        <span class="faint" style="font-size:12px">${p.track_count ?? ''}</span>
      </div>`).join('');
    customDialog({
      title: `Add ${list.length > 1 ? `${list.length} tracks` : 'track'} to…`,
      bodyHtml: `
        <button class="btn ghost block" data-act="new" style="justify-content:flex-start">
          ${icon('plus', 16)} New playlist
        </button>
        <div class="modal-list">${items || '<div class="faint" style="padding:8px">No playlists yet — create one!</div>'}</div>`,
    }, (root, close) => {
      root.querySelectorAll('.modal-item').forEach((it, i) => {
        it.querySelector('.ellipsis').textContent = pls[i].name;
        it.onclick = async () => {
          try {
            const added = await api.addToPlaylist(pls[i].id, list.map(t => ({
              id: t.id, title: t.title, artist: t.artist,
              duration: t.duration, thumbnail: t.thumbnail,
            })));
            close(true);
            if (added.added) toastOk(`Added ${added.added} to ${pls[i].name}`, {
              action: { label: 'View', onClick: () => { location.hash = `#/playlist/${pls[i].id}`; } },
            });
            else toast('Already in that playlist', { icon: 'info' });
            refreshPlaylists();
          } catch (e) { toastErr(e.detail || 'Failed'); }
        };
      });
      root.querySelector('[data-act="new"]').onclick = async () => {
        close(true);
        await newPlaylistDialog(list);
      };
    });
  });
}

export async function newPlaylistDialog(initialTracks = null) {
  const name = await promptDialog({
    title: 'New playlist',
    placeholder: 'Playlist name',
    confirmLabel: 'Create',
  });
  if (!name) return null;
  try {
    const pl = await api.createPlaylist(name);
    if (initialTracks && initialTracks.length) {
      await api.addToPlaylist(pl.id, initialTracks.map(t => ({
        id: t.id, title: t.title, artist: t.artist,
        duration: t.duration, thumbnail: t.thumbnail,
      })));
    }
    await refreshPlaylists();
    toastOk(`Created “${name}”`, {
      action: { label: 'Open', onClick: () => { location.hash = `#/playlist/${pl.id}`; } },
    });
    return pl;
  } catch (e) {
    toastErr(e.detail || 'Create failed');
    return null;
  }
}

// ── sleep timer dialog ───────────────────────────────────────────────

export function openSleepDialog() {
  // dynamic import avoided: player imports actions? no — actions imports player.
  import('./player.js').then(player => {
    const s = get('sleep');
    customDialog({
      title: 'Sleep timer',
      message: 'Pause playback automatically — no more waking up to silence.',
      bodyHtml: `
        ${s.mode === 'timer' ? `<div class="sleep-remaining" id="sl-rem"></div>` : ''}
        <div class="sleep-grid">
          ${[5, 15, 30, 45, 60, 90].map(m => `<button class="chip" data-min="${m}">${m} min</button>`).join('')}
        </div>
        <div class="field">
          <label>Custom (minutes)</label>
          <div class="row gap-s">
            <input class="input" id="sl-custom" type="number" min="1" max="480" placeholder="e.g. 25">
            <button class="btn ghost" id="sl-set">Set</button>
          </div>
        </div>
        <button class="btn ghost block" id="sl-eot">${icon('music', 15)} End of current track</button>
        ${s.mode !== 'off' ? '<button class="btn danger block" id="sl-clear">Clear timer</button>' : ''}`,
    }, (root, close) => {
      const rem = root.querySelector('#sl-rem');
      let tick = null;
      if (rem) {
        const upd = () => {
          const ms = player.sleepRemainingMs();
          rem.textContent = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
        };
        upd(); tick = setInterval(upd, 1000);
      }
      const done = (fn) => (...args) => { if (tick) clearInterval(tick); close(true); fn(...args); };
      root.querySelectorAll('[data-min]').forEach(btn => {
        btn.onclick = done(() => player.setSleepMinutes(+btn.dataset.min));
      });
      root.querySelector('#sl-set').onclick = done(() => {
        const v = +root.querySelector('#sl-custom').value;
        if (v > 0) player.setSleepMinutes(v);
      });
      root.querySelector('#sl-eot').onclick = done(() => player.setSleepEndOfTrack());
      root.querySelector('#sl-clear')?.addEventListener('click', done(() => player.clearSleep()));
    });
  });
}

// ── context menu ─────────────────────────────────────────────────────

let ctxCleanup = null;

export function showTrackMenu(x, y, track, extra = {}) {
  closeTrackMenu();
  const menu = document.getElementById('ctx-menu');
  const offline = isTrackOffline(track);
  const dev = !bridge() && 'caches' in window;
  const devSaved = isDeviceOffline(track);
  menu.innerHTML = `
    <button class="ctx-item" data-a="play">${icon('play', 16, true)} Play</button>
    <button class="ctx-item" data-a="next">${icon('queue', 16)} Play next</button>
    <button class="ctx-item" data-a="queue">${icon('list', 16)} Add to queue</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-a="playlist">${icon('playlist-plus', 16)} Add to playlist…</button>
    <button class="ctx-item" data-a="download">${icon(offline ? 'trash' : 'download', 16)} ${offline ? 'Remove download' : 'Download'}</button>
    ${dev ? `<button class="ctx-item" data-a="device">${icon(devSaved ? 'trash' : 'download', 16)} ${devSaved ? 'Remove from this device' : 'Save to this device'}</button>` : ''}
    <button class="ctx-item" data-a="radio">${icon('radio', 16)} Start radio from this</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-a="copy">${icon('link', 16)} Copy YouTube link</button>
    ${extra.remove ? `<button class="ctx-item danger" data-a="remove">${icon('close', 16)} Remove from this playlist</button>` : ''}
  `;
  menu.classList.remove('hidden');
  // position with viewport clamping
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.min(x, innerWidth - mw - 10)}px`;
  menu.style.top = `${Math.min(y, innerHeight - mh - 10)}px`;

  const handlers = {
    play: () => extra.onPlay ? extra.onPlay() : import('./player.js').then(p => p.playTracks([track])),
    next: () => import('./player.js').then(p => p.enqueue(track, true)),
    queue: () => import('./player.js').then(p => { p.enqueue(track); toast(`Added to queue — ${track.title}`, { icon: 'queue' }); }),
    playlist: () => addToPlaylistDialog(track),
    download: () => offline ? removeDownload(track) : downloadTrack(track),
    device: () => devSaved ? removeDeviceOffline(track) : saveToDevice(track),
    radio: () => { location.hash = `#/radio?seed=${encodeURIComponent(track.id)}`; },
    copy: () => {
      const url = `https://www.youtube.com/watch?v=${track.id}`;
      navigator.clipboard?.writeText(url).then(
        () => toastOk('Link copied'),
        () => toastErr('Copy blocked by browser'));
    },
    remove: () => extra.remove && extra.remove(),
  };
  menu.querySelectorAll('.ctx-item').forEach(btn => {
    btn.onclick = () => { closeTrackMenu(); handlers[btn.dataset.a]?.(); };
  });

  const onDoc = (e) => { if (!menu.contains(e.target)) closeTrackMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeTrackMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
  }, 0);
  ctxCleanup = () => {
    document.removeEventListener('pointerdown', onDoc);
    document.removeEventListener('keydown', onKey);
  };
}

export function closeTrackMenu() {
  const menu = document.getElementById('ctx-menu');
  menu.classList.add('hidden');
  ctxCleanup?.();
  ctxCleanup = null;
}

// ── wire like buttons ────────────────────────────────────────────────

export function initActions() {
  document.getElementById('pb-like').onclick = () => toggleLike(get('current'));
  document.getElementById('np-like').onclick = () => toggleLike(get('current'));
  document.getElementById('btn-new-playlist').onclick = () => newPlaylistDialog();
  window._osmpOpenSleepDialog = openSleepDialog;
  document.getElementById('np-download').onclick = () => {
    const t = get('current');
    if (t) (isTrackOffline(t) ? removeDownload(t) : downloadTrack(t));
  };
  document.getElementById('np-playlist').onclick = () => {
    const t = get('current');
    if (t) addToPlaylistDialog(t);
  };
  document.getElementById('np-radio').onclick = () => {
    const t = get('current');
    if (t) location.hash = `#/radio?seed=${encodeURIComponent(t.id)}`;
  };
  sub('library', () => {
    // sync offline flags into queue/current for UI correctness
  });
}
