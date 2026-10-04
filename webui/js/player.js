// OSMP player engine — queue, shuffle, repeat, sleep timer, media keys,
// progress/seek UI, Android bridge integration. One <audio> element.

import { api, streamUrl, thumbUrl, fmtTime } from './api.js';
import { get, set, sub, persist, load, emit } from './store.js';
import { setAmbientFromCover } from './theme.js';
import { hydrateIcons, icon, setIcon } from './components/icons.js';
import { toast, toastErr } from './components/toast.js';
import { ensureRunning } from './eq.js';

const audio = () => document.getElementById('audio-el');
const el = {}; // cached player-bar elements

let order = [];            // playback order: array of queue indices
let failStreak = 0;        // consecutive load failures (auto-skip guard)
let retriedTrack = null;   // id of the track already given its one silent retry
let sleepTick = null;
let fadeTimer = null;
let fadeVolume = null;     // level the sleep fade last applied (user-nudge guard)
let npOpen = false;
let npCloseTimer = null;
let restoreVolume = null;  // volume before sleep fade

export function bridge() {
  return window.OsmpBridge || null;
}

// ── queue / order ────────────────────────────────────────────────────

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rebuildOrder(keepCurrent = true) {
  const q = get('queue');
  const cur = get('queueIndex');
  order = q.map((_, i) => i);
  if (get('shuffle') && q.length > 1) {
    order = shuffled(order);
    if (keepCurrent && cur >= 0) {
      const at = order.indexOf(cur);
      if (at > 0) { order.splice(at, 1); order.unshift(cur); }
    }
  }
}

function orderPos(queueIdx) { return order.indexOf(queueIdx); }

export function playTracks(tracks, startIndex = 0, opts = {}) {
  if (!tracks || !tracks.length) return;
  const q = tracks.map(t => ({ ...t }));
  set({ queue: q, queueIndex: -1 }, false);
  if (opts.shuffle !== undefined) set({ shuffle: opts.shuffle }, false);
  if (get('shuffle')) {
    order = shuffled(q.map((_, i) => i));
    // The picked track always starts playback — shuffle only reorders what
    // comes after it. Header "Shuffle" buttons opt into a random opener
    // via { random: true }.
    if (opts.random !== true) {
      const pick = Math.min(Math.max(startIndex, 0), q.length - 1);
      const at = order.indexOf(pick);
      if (at > 0) { order.splice(at, 1); order.unshift(pick); }
    }
    startAtOrder(0);
  } else {
    order = q.map((_, i) => i);
    jumpTo(Math.min(startIndex, q.length - 1));
  }
  saveState();
}

export function jumpTo(queueIdx) {
  const q = get('queue');
  if (queueIdx < 0 || queueIdx >= q.length) return;
  const pos = orderPos(queueIdx);
  startAtOrder(pos >= 0 ? pos : 0);
}

// Always report the full media state to the Android notification: a
// payload with only `playing` used to wipe the title/artist there.
function notifyMediaState(playingOverride) {
  const t = get('current');
  bridge()?.notifyMedia?.(safeJson({
    title: t?.title || '',
    artist: t?.artist || '',
    cover: t ? thumbUrl(t) : '',
    playing: playingOverride !== undefined ? playingOverride : !!get('playing'),
  }));
}

function startAtOrder(pos) {
  const q = get('queue');
  if (pos < 0 || pos >= order.length || !q.length) return;
  cancelFade();  // a new start always wins over a running sleep fade
  const idx = order[pos];
  const track = q[idx];
  set({ queueIndex: idx, current: track }, false);
  retriedTrack = null;

  const a = audio();
  a.loop = get('repeat') === 'one';
  a.src = streamUrl(track);
  a.play().catch(err => {
    if (err && err.name === 'NotAllowedError') {
      set({ playing: false });
      updatePlayButton();
      return; // user gesture required; UI stays paused
    }
    console.warn('[player] play failed', err);
  });
  set({ playing: true });
  updateNowPlayingUi();
  document.getElementById('player-bar').classList.remove('hidden');
  api.history(track);
  notifyMediaState(true);
  try { bridge()?.setWakeLock?.(true); } catch { /* no bridge */ }
  saveState();
}

export function toggle() {
  const a = audio();
  const st = get();
  if (!st.current) {
    const q = st.queue;
    if (q.length) jumpTo(st.queueIndex >= 0 && st.queueIndex < q.length ? st.queueIndex : 0);
    return;
  }
  if (st.playing) {
    a.pause();
    set({ playing: false });
    notifyMediaState(false);
  } else {
    // resume — re-resolve if the src failed previously
    if (!a.src || a.error) {
      a.src = streamUrl(st.current);
    }
    a.play().catch(() => toastErr('Playback failed — try again'));
    set({ playing: true });
    notifyMediaState(true);
  }
  updatePlayButton();
  saveState();
}

export function next(auto = false) {
  const st = get();
  if (!order.length) return;
  const pos = orderPos(st.queueIndex);
  if (pos < order.length - 1) {
    startAtOrder(pos + 1);
  } else if (get('repeat') === 'all') {
    startAtOrder(0);
  } else if (auto) {
    // end of queue: stop, keep state
    audio().pause();
    set({ playing: false });
    updatePlayButton();
    if (get('sleep').endOfTrack || get('sleep').endOfQueue) fireSleepEnd();
  } else {
    startAtOrder(0);
  }
}

export function prev() {
  const a = audio();
  if (a.currentTime > 4) { a.currentTime = 0; return; }
  const pos = orderPos(get('queueIndex'));
  if (pos > 0) startAtOrder(pos - 1);
  else if (get('repeat') === 'all') startAtOrder(order.length - 1);
  else a.currentTime = 0;
}

export function cycleRepeat() {
  const modes = ['off', 'all', 'one'];
  const nextMode = modes[(modes.indexOf(get('repeat')) + 1) % 3];
  set({ repeat: nextMode });
  persist('repeat', nextMode);
  audio().loop = nextMode === 'one';
  updateRepeatButton();
}

export function toggleShuffle(force) {
  const on = force !== undefined ? force : !get('shuffle');
  set({ shuffle: on });
  persist('shuffle', on);
  rebuildOrder(true);
  updateShuffleButton();
}

// ── queue mutations ──────────────────────────────────────────────────

export function enqueue(track, atFront = false) {
  const q = [...get('queue'), { ...track }];
  const idx = q.length - 1;
  set({ queue: q }, false);
  if (atFront) {
    // insert right after current in the order
    const pos = orderPos(get('queueIndex'));
    order.splice(pos + 1, 0, idx);
  } else {
    order.push(idx);
  }
  emit('queue');
  saveState();
}

export function removeFromQueue(queueIdx) {
  const st = get();
  const q = st.queue.filter((_, i) => i !== queueIdx);
  const wasCurrent = queueIdx === st.queueIndex;
  const newCurrentIdx = wasCurrent ? -1
    : queueIdx < st.queueIndex ? st.queueIndex - 1 : st.queueIndex;
  set({ queue: q, queueIndex: newCurrentIdx, current: wasCurrent ? st.current : q[newCurrentIdx] || null }, false);
  // splice the removed index out of the playback order instead of rebuilding
  // it — a rebuild would discard drag-reorder / play-next placements
  const op = order.indexOf(queueIdx);
  if (op >= 0) order.splice(op, 1);
  order = order.map(i => (i > queueIdx ? i - 1 : i));
  if (wasCurrent) {
    // keep playing current track to its end; it just isn't in the queue anymore
    set({ queueIndex: -1 }, false);
  }
  emit('queue');
  saveState();
}

export function moveInQueue(fromOrderPos, toOrderPos) {
  if (fromOrderPos === toOrderPos) return;
  const [x] = order.splice(fromOrderPos, 1);
  order.splice(toOrderPos, 0, x);
  emit('queue');
  saveState();
}

export function clearUpcoming() {
  const pos = orderPos(get('queueIndex'));
  if (pos < 0) return;
  order = order.slice(0, pos + 1);
  emit('queue');
  saveState();
  toast('Cleared upcoming tracks', { icon: 'trash' });
}

export function clearQueue() {
  audio().pause();
  audio().removeAttribute('src');
  set({ queue: [], queueIndex: -1, current: null, playing: false }, false);
  order = [];
  emit('queue');
  updateNowPlayingUi();
  saveState();
}

// ── sleep timer ──────────────────────────────────────────────────────

export function setSleepMinutes(minutes) {
  clearSleep(false);
  if (!minutes || minutes <= 0) return;
  const totalMs = minutes * 60000;
  set({ sleep: { mode: 'timer', endsAt: Date.now() + totalMs, totalMs, endOfTrack: false } });
  persist('sleep', get('sleep'));
  startSleepTick();
  updateSleepUi();
  toast(`Sleep timer set — ${minutes} min`, { icon: 'moon' });
}

// ── playback speed ───────────────────────────────────────────────────

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function cycleSpeed() {
  const cur = get('speed') || 1;
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length] || 1;
  setSpeed(nextSpeed);
  return nextSpeed;
}

export function setSpeed(v) {
  const val = SPEEDS.includes(v) ? v : 1;
  const a = audio();
  a.playbackRate = val;
  try { a.preservesPitch = val === 1; } catch { /* older engines */ }
  set({ speed: val });
  persist('speed', val);
  // keep the now-playing chip in sync no matter who set the speed
  const btn = document.getElementById('np-speed');
  const lbl = document.getElementById('np-speed-label');
  if (btn && lbl) {
    btn.classList.toggle('on', val !== 1);
    lbl.textContent = `${val}×`;
  }
  if (val !== 1) toast(`Speed ${val}×`, { icon: 'zap' });
}

export function setSleepEndOfTrack() {
  clearSleep(false);
  set({ sleep: { mode: 'end', endsAt: 0, endOfTrack: true, endOfQueue: false } });
  persist('sleep', get('sleep'));
  updateSleepUi();
  toast('Will sleep at the end of this track', { icon: 'moon' });
}

export function setSleepEndOfQueue() {
  clearSleep(false);
  set({ sleep: { mode: 'queue', endsAt: 0, endOfTrack: false, endOfQueue: true } });
  persist('sleep', get('sleep'));
  updateSleepUi();
  toast('Will sleep when the queue runs out', { icon: 'moon' });
}

export function clearSleep(notify = true) {
  set({ sleep: { mode: 'off', endsAt: 0, endOfTrack: false } });
  persist('sleep', get('sleep'));
  if (sleepTick) { clearInterval(sleepTick); sleepTick = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  if (restoreVolume !== null) {
    audio().volume = restoreVolume;
    restoreVolume = null;
  }
  updateSleepUi();
  if (notify) toast('Sleep timer cleared', { icon: 'moon' });
}

function startSleepTick() {
  if (sleepTick) clearInterval(sleepTick);
  sleepTick = setInterval(() => {
    const s = get('sleep');
    if (s.mode !== 'timer') { clearInterval(sleepTick); sleepTick = null; return; }
    if (Date.now() >= s.endsAt) {
      clearInterval(sleepTick); sleepTick = null;
      fadeOutAndPause();
      set({ sleep: { mode: 'off', endsAt: 0, endOfTrack: false } });
      persist('sleep', get('sleep'));
      updateSleepUi();
      toast('Good night 🌙', { icon: 'moon' });
    } else {
      updateSleepUi();
    }
  }, 1000);
}

function cancelFade() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  if (restoreVolume !== null) { audio().volume = restoreVolume; restoreVolume = null; }
  fadeVolume = null;
}

function fadeOutAndPause() {
  const a = audio();
  restoreVolume = a.volume;
  const steps = 14, stepMs = 430; // ~6 s fade
  let i = 0;
  if (fadeTimer) clearTimeout(fadeTimer);
  const tick = () => {
    i++;
    fadeVolume = Math.max(0, restoreVolume * (1 - i / steps));
    a.volume = fadeVolume;
    if (i < steps) {
      fadeTimer = setTimeout(tick, stepMs);
    } else {
      a.pause();
      set({ playing: false });
      updatePlayButton();
      a.volume = restoreVolume; // restore for next manual play
      restoreVolume = null;
      fadeVolume = null;
      notifyMediaState(false);
    }
  };
  tick();
}

function fireSleepEnd() {
  fadeOutAndPause();
  clearSleep(false);
  toast('Good night 🌙', { icon: 'moon' });
}

export function sleepRemainingMs() {
  const s = get('sleep');
  if (s.mode === 'timer') return Math.max(0, s.endsAt - Date.now());
  return 0;
}

// ── UI updates ───────────────────────────────────────────────────────

function updatePlayButton() {
  const playing = get('playing');
  setIcon(el.play, playing ? 'pause' : 'play', 19);
  el.play.title = playing ? 'Pause' : 'Play';
  el.play.classList.remove('spin-in');
  void el.play.offsetWidth; // restart animation
  el.play.classList.add('spin-in');
  document.querySelectorAll('.eqbars').forEach(eq => eq.classList.toggle('paused', !playing));
  // decorative motion (aurora blobs, cover breathing) freezes whenever
  // nothing is playing — an idle music app shouldn't keep the compositor busy
  document.body.classList.toggle('media-idle', !playing);
  if (playing) startProgressLoop(); else stopProgressLoop();
  // keep the OS transport in step — a stale state makes the next
  // media-key press invert instead of toggle
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* */ }
  }
  notifyMediaState();
}

function updateRepeatButton() {
  const mode = get('repeat');
  const btn = el.repeat;
  btn.classList.toggle('on', mode !== 'off');
  btn.title = mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat queue' : 'Repeat track';
  setIcon(btn, mode === 'one' ? 'repeat' : 'repeat', 19);
  const existing = btn.querySelector('.rep-one');
  if (mode === 'one' && !existing) {
    const badge = document.createElement('span');
    badge.className = 'rep-one'; badge.textContent = '1';
    btn.appendChild(badge);
  } else if (mode !== 'one' && existing) existing.remove();
}

function updateShuffleButton() {
  el.shuffle.classList.toggle('on', get('shuffle'));
}

export function updateNowPlayingUi() {
  const t = get('current');
  if (t) {
    el.title.textContent = t.title;
    el.artist.textContent = t.artist || '';
    el.title.title = t.title;
    el.cover.innerHTML = `<img src="${escapeAttr(thumbUrl(t))}" alt="" onerror="__thumbErr(this)">`;
    document.getElementById('np-title').textContent = t.title;
    document.getElementById('np-artist').textContent = t.artist || '';
    document.getElementById('np-cover').innerHTML = `<img src="${escapeAttr(thumbUrl(t))}" alt="" onerror="__thumbErr(this)">`;
    document.title = `${t.title} · OSMP`;
    setAmbientFromCover(thumbUrl(t));
    updateMediaSession(t);
    updateLikeButtons(t);
  } else {
    el.title.textContent = 'Nothing playing';
    el.artist.textContent = 'pick a track to start';
    el.cover.innerHTML = icon('music', 20);
    document.title = 'OSMP';
    hydrateIcons(el.cover);
  }
  updatePlayButton();
  updateQueueHighlight();
  emit('queue');
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'Unknown artist',
      album: 'OSMP',
      artwork: [
        { src: thumbUrl(t), sizes: '480x360', type: 'image/jpeg' },
        { src: `https://i.ytimg.com/vi/${t.id}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' },
      ],
    });
    navigator.mediaSession.playbackState = get('playing') ? 'playing' : 'paused';
  } catch { /* older browsers */ }
}

export function updateLikeButtons(track) {
  const liked = isLiked(track || get('current'));
  document.querySelectorAll('#pb-like, #np-like').forEach(btn => {
    btn.classList.toggle('on', liked);
    setIcon(btn, liked ? 'heart' : 'heart', 19, liked);
  });
}

export function isLiked(track) {
  if (!track) return false;
  const liked = get('playlists').find(p => p.is_mine && p.name === 'Liked');
  return !!(liked && liked.trackIds && liked.trackIds.includes(track.id));
}

function updateQueueHighlight() {
  const cur = get('current');
  document.querySelectorAll('.tl-row[data-track-id]').forEach(row => {
    const isCur = cur && row.dataset.trackId === cur.id;
    row.classList.toggle('playing', isCur);
    const idxEl = row.querySelector('.tl-idx');
    if (idxEl) {
      idxEl.innerHTML = isCur
        ? `<span class="eqbars ${get('playing') ? '' : 'paused'}"><i></i><i></i><i></i><i></i></span>`
        : `<span class="num">${row.dataset.index ?? ''}</span><span class="play-ico">${icon('play', 14, true)}</span>`;
    }
  });
}

function updateSleepUi() {
  const s = get('sleep');
  el.sleep.classList.toggle('on', s.mode !== 'off');
  const count = el.sleepCount;
  if (s.mode === 'timer') {
    const ms = sleepRemainingMs();
    const min = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
    count.textContent = min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}:${String(sec).padStart(2, '0')}`;
    count.classList.remove('hidden');
    // ring
    let ring = el.sleep.querySelector('.sleep-ring');
    if (!ring) {
      ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ring.setAttribute('class', 'sleep-ring');
      ring.setAttribute('viewBox', '0 0 40 40');
      ring.innerHTML = '<circle cx="20" cy="20" r="18"/>';
      el.sleep.appendChild(ring);
    }
    // drain the circle as the timer runs down (113 = 2π·18, the CSS base)
    const total = s.totalMs || ms || 1;
    ring.querySelector('circle').style.strokeDashoffset =
      String(113 * (1 - Math.min(1, ms / total)));
  } else {
    count.classList.add('hidden');
    count.textContent = s.mode === 'end' ? 'EOT' : s.mode === 'queue' ? 'EOQ' : '';
    if (s.mode === 'end' || s.mode === 'queue') count.classList.remove('hidden');
    el.sleep.querySelector('.sleep-ring')?.remove();
  }
}

// progress bar ------------------------------------------------------------

// Event-driven: rAF only while audio is actually playing; every other state
// paints once from events (timeupdate/seeked/durationchange). Text writes
// are gated on change so a running loop doesn't restyle DOM 60×/s.
let rafId = null;
let lastPaint = { cur: '', dur: '', pct: -1 };

function paintProgress() {
  const a = audio();
  if (!a.duration || !isFinite(a.duration)) return;
  const pct = (a.currentTime / a.duration) * 100;
  if (Math.abs(pct - lastPaint.pct) > 0.02) {
    el.played.style.width = `${pct}%`;
    el.progress.setAttribute('aria-valuenow', Math.round(pct));
    lastPaint.pct = pct;
  }
  const cur = fmtTime(a.currentTime);
  const dur = fmtTime(a.duration);
  if (cur !== lastPaint.cur) { el.cur.textContent = cur; lastPaint.cur = cur; }
  if (dur !== lastPaint.dur) { el.dur.textContent = dur; lastPaint.dur = dur; }
  if (a.buffered.length) {
    const end = a.buffered.end(a.buffered.length - 1);
    el.buffered.style.width = `${Math.min(100, (end / a.duration) * 100)}%`;
  }
}

function startProgressLoop() {
  if (rafId) return;
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    paintProgress();
  };
  rafId = requestAnimationFrame(loop);
}

function stopProgressLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  paintProgress();
}

function bindScrubbing() {
  const bar = el.progress;
  let scrubbing = false;
  const posFromEvent = (e) => {
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  const showTip = (e) => {
    const a = audio();
    if (!a.duration) return;
    let tip = bar.querySelector('.pb-tip');
    if (!tip) { tip = document.createElement('span'); tip.className = 'pb-tip'; bar.appendChild(tip); }
    const frac = posFromEvent(e);
    tip.textContent = fmtTime(a.duration * frac);
    tip.style.left = `${frac * 100}%`;
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!audio().duration) return;
    scrubbing = true;
    bar.classList.add('scrubbing');
    bar.setPointerCapture(e.pointerId);
    showTip(e);
  });
  bar.addEventListener('pointermove', (e) => {
    if (scrubbing) {
      const frac = posFromEvent(e);
      el.played.style.width = `${frac * 100}%`;
      showTip(e);
    } else if (e.buttons === 0 && audio().duration) {
      showTip(e);
    }
  });
  bar.addEventListener('pointerleave', () => { if (!scrubbing) bar.querySelector('.pb-tip')?.remove(); });
  bar.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    bar.classList.remove('scrubbing');
    bar.querySelector('.pb-tip')?.remove();
    audio().currentTime = posFromEvent(e) * audio().duration;
  });
  bar.addEventListener('pointercancel', () => {
    // gesture stolen mid-scrub — drop the visual state without seeking
    scrubbing = false;
    bar.classList.remove('scrubbing');
    bar.querySelector('.pb-tip')?.remove();
  });
  bar.addEventListener('keydown', (e) => {
    const a = audio();
    if (!a.duration) return;
    if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration, a.currentTime + 5);
    if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5);
  });
}

// volume -------------------------------------------------------------------

function setVolume(v, fromUser = true) {
  v = Math.min(1, Math.max(0, v));
  audio().volume = v;
  set({ volume: v, muted: v === 0 }, false);
  if (fromUser) persist('volume', v);
  el.vol.value = Math.round(v * 100);
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const v = get('muted') ? 0 : get('volume');
  const name = v === 0 ? 'volume-mute' : v < 0.5 ? 'volume-low' : 'volume';
  setIcon(el.mute, name, 19);
}

export function toggleMute() {
  const muted = !get('muted');
  set({ muted });
  audio().muted = muted;
  persist('muted', muted);
  updateVolumeIcon();
}

// now playing overlay -------------------------------------------------------

export function openNowPlaying() {
  const ov = document.getElementById('np-overlay');
  if (!get('current')) return;
  if (npCloseTimer) { clearTimeout(npCloseTimer); npCloseTimer = null; }
  ov.classList.remove('hidden', 'closing');
  ov.setAttribute('aria-hidden', 'false');
  npOpen = true;
}

export function closeNowPlaying() {
  const ov = document.getElementById('np-overlay');
  ov.classList.add('closing');
  if (npCloseTimer) clearTimeout(npCloseTimer);
  npCloseTimer = setTimeout(() => {
    npCloseTimer = null;
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
  }, 280);
  npOpen = false;
}

export function isNowPlayingOpen() { return npOpen; }

// state persistence ----------------------------------------------------------

let _saveT = null;
function saveState() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    const st = get();
    persist('lastState', {
      queue: st.queue.slice(0, 300),
      queueIndex: st.queueIndex,
      position: audio().currentTime || 0,
      shuffle: st.shuffle,
      repeat: st.repeat,
    });
  }, 700);
}

export async function restoreState() {
  const saved = load('lastState');
  if (saved && Array.isArray(saved.queue) && saved.queue.length) {
    set({ queue: saved.queue, queueIndex: saved.queueIndex ?? -1 }, false);
    set({ current: saved.queue[saved.queueIndex] || null }, false);
    set({ shuffle: saved.shuffle, repeat: saved.repeat || 'off' }, false);
    rebuildOrder(true);
    if (get('current')) {
      const a = audio();
      const restoredId = get('current').id;
      a.src = streamUrl(get('current'));
      a.loop = get('repeat') === 'one';
      a.addEventListener('loadedmetadata', () => {
        // only resume into the restored track — if the user already picked a
        // different one, this late metadata event must not seek it
        if (get('current')?.id !== restoredId) return;
        if (saved.position > 1 && saved.position < a.duration - 5) a.currentTime = saved.position;
      }, { once: true });
      document.getElementById('player-bar').classList.remove('hidden');
      updateNowPlayingUi();
    }
  }
}

// init -------------------------------------------------------------------------

export function initPlayer() {
  Object.assign(el, {
    play: document.getElementById('pb-play'),
    prev: document.getElementById('pb-prev'),
    next: document.getElementById('pb-next'),
    shuffle: document.getElementById('pb-shuffle'),
    repeat: document.getElementById('pb-repeat'),
    progress: document.getElementById('pb-progress'),
    played: document.getElementById('pb-played'),
    buffered: document.getElementById('pb-buffered'),
    cur: document.getElementById('pb-cur'),
    dur: document.getElementById('pb-dur'),
    title: document.getElementById('pb-title'),
    artist: document.getElementById('pb-artist'),
    cover: document.getElementById('pb-cover'),
    vol: document.getElementById('pb-vol'),
    mute: document.getElementById('pb-mute'),
    sleep: document.getElementById('pb-sleep'),
    sleepCount: document.getElementById('pb-sleep-count'),
  });
  hydrateIcons();

  const a = audio();

  // restored prefs
  set({
    shuffle: !!load('shuffle', false),
    repeat: load('repeat', 'off') || 'off',
    volume: load('volume', 0.8),
    muted: !!load('muted', false),
    speed: load('speed', 1) || 1,
  }, false);
  if (get('speed') !== 1) {
    a.playbackRate = get('speed');
    try { a.preservesPitch = false; } catch { /* older engines */ }
  }
  a.volume = get('volume');
  a.muted = get('muted');
  el.vol.value = Math.round(get('volume') * 100);
  updateVolumeIcon();
  updateShuffleButton();
  updateRepeatButton();

  // restore sleep timer if it was set and hasn't expired
  const savedSleep = load('sleep');
  if (savedSleep && savedSleep.mode === 'timer' && savedSleep.endsAt > Date.now()) {
    set({ sleep: savedSleep }, false);
    startSleepTick();
  } else if (savedSleep && (savedSleep.mode === 'end' || savedSleep.mode === 'queue')) {
    set({ sleep: savedSleep }, false);
  }
  updateSleepUi();

  // controls
  el.play.onclick = toggle;
  el.prev.onclick = prev;
  el.next.onclick = () => next(false);
  el.shuffle.onclick = () => toggleShuffle();
  el.repeat.onclick = cycleRepeat;
  el.vol.oninput = () => setVolume(el.vol.value / 100);
  el.mute.onclick = toggleMute;
  el.title.onclick = openNowPlaying;
  el.artist.onclick = () => {
    const t = get('current');
    if (t && t.artist) location.hash = `#/artist/${encodeURIComponent(t.artist)}`;
  };
  document.getElementById('np-artist').onclick = () => {
    const t = get('current');
    if (t && t.artist) location.hash = `#/artist/${encodeURIComponent(t.artist)}`;
  };
  document.getElementById('pb-cover-btn').onclick = openNowPlaying;
  document.getElementById('pb-expand').onclick = openNowPlaying;
  bindScrubbing();
  paintProgress();  // the rAF loop only runs while audio actually plays

  // audio events
  a.addEventListener('playing', () => {
    set({ playing: true }); updatePlayButton(); failStreak = 0;
    startProgressLoop();
    ensureRunning(); // an EQ'd element is silent while its context sleeps
  });
  a.addEventListener('pause', () => { set({ playing: false }); updatePlayButton(); stopProgressLoop(); });
  a.addEventListener('ended', () => {
    stopProgressLoop();
    if (fadeTimer) return;  // sleep fade running — advance would start the next track at fade volume
    if (get('sleep').endOfTrack && get('repeat') !== 'one') { fireSleepEnd(); return; }
    if (get('repeat') !== 'one') next(true);
  });
  a.addEventListener('timeupdate', () => { if (!rafId) paintProgress(); });
  a.addEventListener('durationchange', () => paintProgress());
  a.addEventListener('error', () => {
    const t = get('current');
    if (!t) return;

    // YouTube briefly refuses resolves at times (bot checks); a fresh
    // request a couple of seconds later almost always goes through. Give
    // every track one silent second attempt before moving on.
    if (retriedTrack !== t.id) {
      retriedTrack = t.id;
      setTimeout(() => {
        if (get('current') !== t) return;  // user moved on meanwhile
        const base = streamUrl(t);
        // cache-buster only for server-relative streams; the Android
        // offline virtual host matches plain paths
        a.src = base.startsWith('/')
          ? base + (base.includes('?') ? '&' : '?') + 'retry=1'
          : base;
        a.play().catch(() => { /* the error handler picks it up */ });
      }, 1800);
      return;
    }

    failStreak++;
    if (failStreak <= 3) {
      toastErr(`Can't play “${t.title}” — skipping`);
      setTimeout(() => {
        if (get('current') !== t) return;  // user picked something else meanwhile
        next(true);
      }, 900);
    } else {
      toastErr('Playback keeps failing — YouTube is likely refusing requests for the moment. Try again in a minute.', { timeout: 8000 });
      set({ playing: false });
      updatePlayButton();
    }
  });
  a.addEventListener('volumechange', () => {
    // The sleep fade sets volume itself; any level that doesn't match the
    // fade's last step is the user moving the slider mid-fade — hand
    // control back instead of stomping their choice on the next tick.
    if (fadeTimer && fadeVolume !== null && Math.abs(a.volume - fadeVolume) > 0.015) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
      restoreVolume = null;
      fadeVolume = null;
    }
  });

  // media keys / OS integration
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    // guarded like __osmpMedia below — an unguarded toggle makes the OS's
    // stale play/pause button invert the real state
    ms.setActionHandler('play', () => { if (!get('playing')) toggle(); });
    ms.setActionHandler('pause', () => { if (get('playing')) toggle(); });
    ms.setActionHandler('previoustrack', prev);
    ms.setActionHandler('nexttrack', () => next(false));
    try {
      ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) a.currentTime = d.seekTime; });
    } catch { /* unsupported */ }
  }

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) next(false);
    else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
    else if (e.key === 'm') toggleMute();
    else if (e.key === '.') cycleSpeed();
    else if (e.key === ',') setSpeed(1);
    else if (e.key === 'l') import('./lyrics.js').then(m => m.toggleLyrics());
    else if (e.key === 's') toggleShuffle();
    else if (e.key === 'q') document.getElementById('pb-queue')?.click();
    else if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      location.hash = '#/search';
      setTimeout(() => document.getElementById('sr-input')?.focus(), 120);
    } else if (e.key === '?') {
      import('./actions.js').then(a => a.showShortcutsHelp());
    }
  });

  // queue drawer
  const drawer = document.getElementById('queue-drawer');
  const backdrop = document.getElementById('queue-backdrop');
  const openDrawer = () => {
    renderQueueDrawer();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => backdrop.classList.add('show'));
  };
  const closeDrawer = () => {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.classList.add('hidden'), 300);
  };
  document.getElementById('pb-queue').onclick = () =>
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  document.getElementById('qd-close').onclick = closeDrawer;
  backdrop.onclick = closeDrawer;
  document.getElementById('qd-clear').onclick = () => { clearQueue(); renderQueueDrawer(); };
  document.getElementById('qd-clear-upcoming').onclick = () => { clearUpcoming(); renderQueueDrawer(); };
  document.getElementById('np-speed').onclick = () => cycleSpeed();
  { // reflect persisted speed on boot
    const v = get('speed') || 1;
    document.getElementById('np-speed').classList.toggle('on', v !== 1);
    document.getElementById('np-speed-label').textContent = `${v}×`;
  }
  document.getElementById('np-close').onclick = closeNowPlaying;
  document.getElementById('np-queue').onclick = openDrawer;
  window._osmpCloseDrawer = closeDrawer;
  window._osmpOpenDrawer = openDrawer;
  sub('queue', () => { if (drawer.classList.contains('open')) renderQueueDrawer(); updateQueueHighlight(); });

  // sleep buttons (bar + np overlay open the same dialog via app.js binding)
  el.sleep.onclick = () => window._osmpOpenSleepDialog?.();
  document.getElementById('np-sleep').onclick = () => window._osmpOpenSleepDialog?.();

  // native app hooks (Android media notification / lock-screen controls)
  window.__osmpMedia = (action) => {
    const map = {
      play: () => { if (!get('playing')) toggle(); },
      pause: () => { if (get('playing')) toggle(); },
      toggle,
      next: () => next(false),
      prev,
      stop: () => { a.pause(); set({ playing: false }); updatePlayButton(); },
    };
    map[action]?.();
  };

  restoreState();
}

// ── queue drawer rendering ───────────────────────────────────────────

let dragFrom = null;

export function renderQueueDrawer() {
  const now = document.getElementById('qd-now');
  const list = document.getElementById('qd-list');
  const st = get();
  const cur = st.current;

  now.innerHTML = cur ? `
    <div class="qd-label">Now playing</div>
    <div class="qd-item current" data-qi="${st.queueIndex}">
      <img src="${escapeAttr(thumbUrl(cur))}" alt="" onerror="__thumbErr(this)">
      <div class="qd-meta">
        <div class="qd-title"></div>
        <div class="qd-artist"></div>
      </div>
      <span class="eqbars ${st.playing ? '' : 'paused'}"><i></i><i></i><i></i><i></i></span>
    </div>` : '';
  if (cur) {
    now.querySelector('.qd-title').textContent = cur.title;
    now.querySelector('.qd-artist').textContent = cur.artist || '';
  }

  // upcoming = order after current position
  const pos = orderPos(st.queueIndex);
  const upcoming = order.slice(pos + 1).map(qi => ({ t: st.queue[qi], qi }));

  if (!upcoming.length) {
    list.innerHTML = `<div class="qd-empty">${cur ? 'Nothing next — add more tracks' : 'Queue is empty'}</div>`;
    return;
  }
  list.innerHTML = `<div class="qd-label">Next up · ${upcoming.length}</div>`;
  upcoming.forEach(({ t, qi }, i) => {
    const item = document.createElement('div');
    item.className = 'qd-item';
    item.draggable = true;
    item.dataset.qi = qi;
    item.dataset.opos = pos + 1 + i;
    item.innerHTML = `
      <img src="${escapeAttr(thumbUrl(t))}" alt="" loading="lazy" onerror="__thumbErr(this)">
      <div class="qd-meta">
        <div class="qd-title"></div>
        <div class="qd-artist"></div>
      </div>
      <button class="icon-btn sm qd-x" title="Remove"></button>`;
    item.querySelector('.qd-title').textContent = t.title;
    item.querySelector('.qd-artist').textContent = t.artist || '';
    item.querySelector('.qd-x').innerHTML = icon('close', 15);
    item.querySelector('.qd-x').onclick = (e) => {
      e.stopPropagation();
      removeFromQueue(qi);
    };
    item.onclick = () => jumpTo(qi);
    item.addEventListener('dragstart', (e) => {
      dragFrom = +item.dataset.opos;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFrom));
    });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); dragFrom = null; });
    item.addEventListener('dragover', (e) => { e.preventDefault(); });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = +item.dataset.opos;
      if (dragFrom !== null && to !== dragFrom) moveInQueue(dragFrom, to);
    });
    list.appendChild(item);
  });
}

function safeJson(o) { try { return JSON.stringify(o); } catch { return '{}'; } }

// attribute-safe escaping — thumbnails come from the server (and restored
// backups), so their URLs never go into markup raw
function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
