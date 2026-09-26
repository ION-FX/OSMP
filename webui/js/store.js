// OSMP store — tiny pub/sub state container shared across modules.

const state = {
  config: null,          // server /api/config payload
  settings: {},          // server settings
  playlists: [],         // sidebar + pickers
  library: new Map(),    // id -> track (server-known tracks; offline flag)
  queue: [],             // [{...track}]
  queueIndex: -1,
  current: null,         // shorthand for queue[queueIndex]
  playing: false,
  shuffle: false,
  repeat: 'off',         // off | all | one
  volume: 0.8,
  muted: false,
  sleep: { mode: 'off', endsAt: 0, endOfTrack: false }, // mode: off|timer|end
  downloads: new Map(),  // video_id -> job state {status, progress}
  ambient: { h1: null, h2: null },
  route: { name: 'home', params: {} },
  online: true,          // server reachable
};

const subs = new Map(); // key -> Set<fn>   (key '*' = everything)

export function get(key) {
  return key ? state[key] : state;
}

export function set(patch, notify = true) {
  const touched = [];
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v || typeof v === 'object') touched.push(k);
    state[k] = v;
  }
  if (notify) emitKeys(touched);
  return state;
}

function emitKeys(keys) {
  for (const k of keys) {
    (subs.get(k) || []).forEach(fn => safe(fn, state[k], k));
  }
  (subs.get('*') || []).forEach(fn => safe(fn, state, '*'));
}

export function emit(key) {
  (subs.get(key) || []).forEach(fn => safe(fn, state[key], key));
  (subs.get('*') || []).forEach(fn => safe(fn, state, '*'));
}

function safe(fn, val, key) {
  try { fn(val, key); } catch (e) { console.error(`[store] subscriber "${key}" failed:`, e); }
}

export function sub(key, fn) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(fn);
  return () => subs.get(key).delete(fn);
}

// ── persistence helpers (localStorage with a namespace) ──────────────
const NS = 'osmp.';
export function persist(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* quota/private */ }
}
export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

// ── library helpers ──────────────────────────────────────────────────
export function markOffline(trackId, offline) {
  const t = state.library.get(trackId);
  if (t) { t.offline = offline; }
  // queue entries share the flag too
  state.queue.forEach(q => { if (q.id === trackId) q.offline = offline; });
  if (state.current && state.current.id === trackId) state.current.offline = offline;
  emit('library');
  emit('queue');
}

export function rememberTracks(tracks) {
  for (const t of tracks || []) {
    if (!t || !t.id) continue;
    const prev = state.library.get(t.id);
    state.library.set(t.id, prev ? { ...prev, ...t } : { ...t });
  }
  emit('library');
}
