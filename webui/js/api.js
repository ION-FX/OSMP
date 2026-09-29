// OSMP API client — thin fetch wrapper with auth handling and typed helpers.

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function req(path, opts = {}) {
  const { method = 'GET', body, raw } = opts;
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (method !== 'GET' && !path.startsWith('/api/auth/') && path !== '/api/setup') {
      // server unreachable — journal the change for the next reconnect
      const outbox = outboxAll();
      outbox.push({ m: method, p: path, b: body, t: Date.now() });
      outboxSave(outbox);
      throw new ApiError(0, 'Offline — change will sync when the server is back');
    }
    throw new ApiError(0, 'Cannot reach the OSMP server');
  }
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Locked');
  }
  if (raw) return res;
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.detail) || `Request failed (${res.status})`);
  }
  return data;
}

// ── offline outbox ───────────────────────────────────────────────────
// Mutating requests that fail because the server is unreachable are journaled
// here and replayed in order on reconnect, so plays/likes/edits made offline
// sync when the server comes back.

const OUTBOX_KEY = 'osmp.outbox';
const OUTBOX_MAX = 500;

function outboxAll() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }
  catch { return []; }
}

export function outboxCount() {
  return outboxAll().length;
}

function outboxSave(entries) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-OUTBOX_MAX)));
}

export async function outboxFlush() {
  const entries = outboxAll();
  if (!entries.length) return 0;
  const keep = [];
  let synced = 0;
  let stop = false;
  for (const en of entries) {
    if (stop) { keep.push(en); continue; }
    try {
      const res = await fetch(en.p, {
        method: en.m,
        headers: { 'Content-Type': 'application/json' },
        body: en.b === undefined ? undefined : JSON.stringify(en.b),
        credentials: 'same-origin',
      });
      if (res.status === 401) { keep.push(en); stop = true; continue; }  // need re-login
      if (res.ok) synced++;
      // other 4xx/5xx: server state moved on — drop the stale change
    } catch {
      keep.push(en);  // still offline — keep everything from here on
      stop = true;
    }
  }
  outboxSave(keep);
  return synced;
}

export const api = {
  // meta
  health:        () => req('/api/health'),
  config:        () => req('/api/config'),
  login:         (username, password) =>
    req('/api/auth/login', { method: 'POST', body: { username, password } }),
  setup:         (username, password, name) =>
    req('/api/setup', { method: 'POST', body: { username, password, name } }),
  logout:        () => req('/api/auth/logout', { method: 'POST' }),
  me:            () => req('/api/auth/me'),

  // users (admin)
  users:         () => req('/api/users'),
  createUser:    (username, password, role = 'user') =>
    req('/api/users', { method: 'POST', body: { username, password, role } }),
  deleteUser:    (id) => req(`/api/users/${id}`, { method: 'DELETE' }),
  setUserPassword: (id, password) =>
    req(`/api/users/${id}/password`, { method: 'POST', body: { password } }),

  // discovery
  search:        (q, limit = 20) => req(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  track:         (id) => req(`/api/track/${encodeURIComponent(id)}`),

  // library
  library:       (offlineOnly = false) => req(`/api/library?offline_only=${offlineOnly ? 'true' : 'false'}`),
  download:      (video_id, title, artist) =>
    req('/api/library/download', { method: 'POST', body: { video_id, title, artist } }),
  jobStatus:     (jobId) => req(`/api/library/jobs/${jobId}`),
  removeDownload:(id) => req(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // playlists
  playlists:     () => req('/api/playlists'),
  createPlaylist:(name, description = '', kind = 'user') =>
    req('/api/playlists', { method: 'POST', body: { name, description, kind } }),
  playlist:      (id) => req(`/api/playlists/${id}`),
  renamePlaylist:(id, name, description) =>
    req(`/api/playlists/${id}`, { method: 'PATCH', body: { name, description } }),
  deletePlaylist:(id) => req(`/api/playlists/${id}`, { method: 'DELETE' }),
  addToPlaylist: (id, tracks) =>
    req(`/api/playlists/${id}/tracks`, { method: 'POST', body: { tracks } }),
  removeFromPlaylist: (id, trackId) =>
    req(`/api/playlists/${id}/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' }),
  reorderPlaylist: (id, order) =>
    req(`/api/playlists/${id}/tracks`, { method: 'PUT', body: { order } }),

  // import from YouTube playlists/albums/channels
  importPreview: (url) => req('/api/import/preview', { method: 'POST', body: { url } }),
  importApply:   (preview_id, name, track_ids) =>
    req('/api/import/apply', { method: 'POST', body: { preview_id, name, track_ids } }),

  // radio / llm
  radio:         (seed, count = 25) =>
    req(`/api/radio/generate?seed=${encodeURIComponent(seed)}&count=${count}`),
  llmCurate:     (prompt, count = 20) =>
    req('/api/radio/llm', { method: 'POST', body: { prompt, count } }),

  // lyrics & stats
  lyrics:        (trackId) => req(`/api/lyrics/${encodeURIComponent(trackId)}`),
  stats:         (days = 30, scope = 'me') =>
    req(`/api/stats?days=${days}&scope=${scope}`),
  mixes:         () => req('/api/mixes'),
  historyLog:    (limit = 200) => req(`/api/history/log?limit=${limit}`),
  artist:        (name) => req(`/api/artist?name=${encodeURIComponent(name)}`),
  artists:       (q = '') => req(`/api/artists?q=${encodeURIComponent(q)}`),

  // uploads (your own music)
  uploadFile:    (file) => fetch('/api/upload', {
                    method: 'POST',
                    credentials: 'same-origin',
                    body: (() => {
                      const fd = new FormData();
                      fd.append('file', file, file.name);
                      return fd;
                    })(),
                  }).then(async (res) => {
                    let data = null;
                    try { data = await res.json(); } catch { /* empty body */ }
                    if (!res.ok) throw new ApiError(res.status,
                      (data && data.detail) || `Upload failed (${res.status})`);
                    return data;
                  }),
  scanLibrary:   (path) => req('/api/upload/scan', { method: 'POST', body: { path } }),

  // backup (admin)
  backupRestore: (data) => req('/api/backup/restore', { method: 'POST', body: { data } }),

  // settings & history
  settings:      () => req('/api/settings'),
  saveSettings:  (patch) => req('/api/settings', { method: 'PUT', body: patch }),
  history:       (trackId) => req('/api/history', { method: 'POST', body: { track_id: trackId } }).catch(() => {}),
  home:          () => req('/api/home'),

  // self-update
  updateCheck:   () => req('/api/update/check', { method: 'POST' }),
  updateApply:   (kind = 'full') => req('/api/update/apply', { method: 'POST', body: { kind } }),
  updateStatus:  (jobId) => req(`/api/update/status/${jobId}`),
};

// stream URLs — the player uses these directly on the <audio> element
export const streamUrl = (track) => {
  const id = track.id;
  if (window.OsmpBridge && window.OsmpBridge.isDownloaded && window.OsmpBridge.isDownloaded(id)) {
    return `https://offline.osmp.local/${id}`;
  }
  if (track.offline) return `/api/library/stream/${encodeURIComponent(id)}`;
  const fmt = localStorage.getItem('osmp.format') || 'auto';
  return `/api/stream/${encodeURIComponent(id)}?fmt=${fmt}`;
};

export const thumbUrl = (track, size = 'maxres') => {
  if (!track) return '';
  if (track.thumbnail) return track.thumbnail.replace('hqdefault', size + 'default');
  return `https://i.ytimg.com/vi/${track.id}/${size}default.jpg`;
};

export function fmtTime(sec) {
  if (!sec && sec !== 0) return '–:––';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDurLong(sec) {
  if (!sec) return '0 min';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  return `${m} min`;
}

export function fmtBytes(b) {
  if (!b) return '0 MB';
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function extractVideoId(input) {
  const s = (input || '').trim();
  let m = s.match(/(?:v=|\/videos\/|embed\/|youtu\.be\/|v\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

// True when the input points at an importable YouTube playlist / album /
// channel (not a single video, not an endless RD mix). Mirrors the server's
// import_source() so links route to the import view before they degrade to
// a keyword search.
export function isImportLink(input) {
  let s = (input || '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^www\./i.test(s)) s = 'https://' + s;
  if (!/^https?:\/\//i.test(s)) return /^(PL|OL|UU)[A-Za-z0-9_-]{8,}$/.test(s);
  const list = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (list) return !/^(RD|UL|MM)/.test(list[1]);
  if (/^https?:\/\/([a-z0-9-]+\.)?youtube\.com\/(channel\/[^/?#]+|@[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/i.test(s)) return true;
  if (/^https?:\/\/music\.youtube\.com\/browse\//i.test(s)) return true;
  return false;
}
