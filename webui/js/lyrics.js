// Lyrics panel — time-synced (LRC) lyrics that highlight and auto-center as
// the track plays. Lines are clickable to seek. Falls back to plain un-timed
// lyrics, and reloads automatically when the track changes while open.

import { api, thumbUrl } from './api.js';
import { get } from './store.js';
import { icon } from './components/icons.js';
import { setAmbientFromCover } from './theme.js';

let open = false;
let raf = null;
let trackId = null;      // lyrics currently loaded for
let lines = [];          // [{t, line}] — empty when only plain lyrics exist
let synced = false;
let activeIdx = -1;
let userScrollUntil = 0; // suppress auto-centering while the user scrolls

export function initLyrics() {
  document.getElementById('pb-lyrics').onclick = toggleLyrics;
  document.getElementById('np-lyrics').onclick = openLyrics;
  document.getElementById('ly-close').onclick = closeLyrics;
  document.getElementById('ly-np').onclick = () => {
    closeLyrics();
    import('./player.js').then(p => p.openNowPlaying());
  };
  const scroller = document.getElementById('ly-scroll');
  // wheel/touchmove are the only trustworthy "human is scrolling" signals —
  // programmatic scrollTo fires plain scroll events too
  scroller.addEventListener('wheel', () => { userScrollUntil = Date.now() + 3500; },
    { passive: true });
  scroller.addEventListener('touchmove', () => { userScrollUntil = Date.now() + 3500; },
    { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeLyrics();
  });
}

export function isLyricsOpen() { return open; }

export function openLyrics() {
  const t = get('current');
  if (!t) return;
  const ov = document.getElementById('lyrics-overlay');
  ov.classList.remove('hidden');
  ov.setAttribute('aria-hidden', 'false');
  open = true;
  document.getElementById('ly-title').textContent = t.title || '';
  document.getElementById('ly-artist').textContent = t.artist || '';
  setAmbientFromCover(thumbUrl(t));
  document.getElementById('pb-lyrics').classList.add('on');
  ensureLoaded();
  startLoop();
}

export function toggleLyrics() { open ? closeLyrics() : openLyrics(); }

export function closeLyrics() {
  const ov = document.getElementById('lyrics-overlay');
  ov.classList.add('hidden');
  ov.setAttribute('aria-hidden', 'true');
  open = false;
  stopLoop();
  document.getElementById('pb-lyrics').classList.remove('on');
}

// ── loading ─────────────────────────────────────────────────────────

async function ensureLoaded(force = false) {
  const t = get('current');
  if (!t) return;
  if (!force && trackId === t.id) return;
  trackId = t.id;
  activeIdx = -1;
  const col = document.getElementById('ly-col');
  const scroller = document.getElementById('ly-scroll');
  scroller.classList.remove('plain');
  col.innerHTML = `<div class="ly-loading"><span class="spin">${icon('spinner', 26)}</span>Searching for lyrics…</div>`;
  let data = null;
  try {
    data = await api.lyrics(t.id);
  } catch (e) {
    data = { found: false, offline: e.status === 0 };
  }
  if (trackId !== t.id) return;  // track changed while fetching
  render(data);
}

function render(data) {
  const col = document.getElementById('ly-col');
  const scroller = document.getElementById('ly-scroll');
  lines = data && data.synced && Array.isArray(data.lines) ? data.lines : [];
  synced = lines.length > 0;
  scroller.classList.toggle('plain', !synced);

  if (!data || !data.found) {
    lines = [];
    col.innerHTML = `
      <div class="ly-empty">
        <span class="ly-empty-ico">${icon('lyrics', 42)}</span>
        <h3>No lyrics${data && data.instrumental ? ' — instrumental' : ''}</h3>
        <p>${data && data.offline
          ? 'Lyrics are fetched by your server — reconnect to look them up.'
          : 'The community lyrics database (LRCLIB) doesn’t have this track yet.'}</p>
        ${!data || !data.offline ? '<button class="btn ghost" data-act="retry">Try again</button>' : ''}
      </div>`;
    col.querySelector('[data-act="retry"]')?.addEventListener('click', () => ensureLoaded(true));
    return;
  }

  const entries = synced ? lines : String(data.plain || '').split('\n');
  col.innerHTML = '';
  entries.forEach((entry) => {
    const p = document.createElement('p');
    p.className = 'ly-line';
    if (synced) {
      p.dataset.t = String(entry.t);
      p.title = 'Jump here';
      p.onclick = () => {
        const a = document.getElementById('audio-el');
        if (a && isFinite(entry.t)) {
          a.currentTime = entry.t + 0.02;
          userScrollUntil = 0;  // resume following immediately
        }
      };
    }
    p.textContent = (synced ? entry.line : entry) || '\u00A0';
    col.appendChild(p);
  });
}

// ── sync loop ───────────────────────────────────────────────────────

function startLoop() {
  stopLoop();
  const step = () => {
    raf = requestAnimationFrame(step);
    const t = get('current');
    if (!t) return;
    if (t.id !== trackId) { ensureLoaded(); return; }
    if (!synced) return;
    const a = document.getElementById('audio-el');
    const cur = a ? (a.currentTime || 0) : 0;
    let i = -1;
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].t <= cur) i = j; else break;
    }
    if (i !== activeIdx) setActive(i);
  };
  raf = requestAnimationFrame(step);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}

function setActive(i) {
  activeIdx = i;
  const col = document.getElementById('ly-col');
  const rows = col.querySelectorAll('.ly-line');
  rows.forEach(r => r.classList.remove('active', 'past'));
  if (i < 0 || !rows.length) return;
  rows[i].classList.add('active');
  for (let j = Math.max(0, i - 2); j < i; j++) rows[j].classList.add('past');
  if (Date.now() < userScrollUntil) return;
  const el = rows[i];
  const scroller = document.getElementById('ly-scroll');
  scroller.scrollTo({
    top: el.offsetTop - scroller.clientHeight / 2 + el.clientHeight / 2,
    behavior: 'smooth',
  });
}
