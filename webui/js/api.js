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

export const api = {
  // meta
  health:        () => req('/api/health'),
  config:        () => req('/api/config'),
  auth:          (pin) => req('/api/auth', { method: 'POST', body: { pin } }),
  logout:        () => req('/api/auth/logout', { method: 'POST' }),

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

  // radio / llm
  radio:         (seed, count = 25) =>
    req(`/api/radio/generate?seed=${encodeURIComponent(seed)}&count=${count}`),
  llmCurate:     (prompt, count = 20) =>
    req('/api/radio/llm', { method: 'POST', body: { prompt, count } }),

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
