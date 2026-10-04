// Stats — listening history dashboards: plays/minutes, per-day and per-hour
// charts, top artists and top tracks. All charts are hand-rolled inline SVG
// (no chart library, no build step). Minutes are plays × track duration, as
// estimated by the server.

import { api, thumbUrl, fmtTime } from '../api.js';
import { get, load, persist, rememberTracks } from '../store.js';
import { icon } from '../components/icons.js';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

export async function mount(root, params) {
  const cfg = get('config') || {};
  const isAdmin = cfg.user && cfg.user.role === 'admin';
  let days = Math.min(90, Math.max(7, parseInt(params.days, 10)
    || load('statsDays', 30)));
  let scope = params.scope === 'all' && isAdmin ? 'all' : 'me';

  root.innerHTML = `
    <div class="view-head">
      <h1>${icon('chart', 26)} &nbsp;Stats</h1>
      <div class="row gap-s" style="flex-wrap:wrap">
        <a class="text-btn" href="#/history" title="Every play, newest first">Full history →</a>
        <div class="chip-row" id="st-ranges"></div>
        ${isAdmin ? `
          <div class="chip-row" id="st-scope" title="Whose plays to count">
            <button class="chip" data-scope="me">Just me</button>
            <button class="chip" data-scope="all">Everyone</button>
          </div>` : ''}
      </div>
    </div>
    <div id="st-body"><div class="stats-skel">
      ${Array.from({ length: 6 }, () => '<div class="skel skel-line"></div>').join('')}
    </div></div>`;

  const ranges = root.querySelector('#st-ranges');
  RANGES.forEach(r => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = r.label;
    b.dataset.days = r.days;
    b.onclick = () => {
      days = r.days;
      persist('statsDays', r.days);
      renderChips();
      loadStats();
    };
    ranges.appendChild(b);
  });
  if (isAdmin) {
    root.querySelectorAll('#st-scope .chip').forEach(b => {
      b.onclick = () => { scope = b.dataset.scope; renderChips(); loadStats(); };
    });
  }

  function renderChips() {
    root.querySelectorAll('#st-ranges .chip').forEach(b =>
      b.classList.toggle('on', +b.dataset.days === days));
    root.querySelectorAll('#st-scope .chip').forEach(b =>
      b.classList.toggle('on', b.dataset.scope === scope));
  }
  renderChips();

  async function loadStats() {
    const body = root.querySelector('#st-body');
    try {
      const s = await api.stats(days, scope);
      body.innerHTML = '';
      if (!s.plays) {
        body.innerHTML = `
          <div class="empty">
            <span class="empty-ico">${icon('chart', 40)}</span>
            <h3>Nothing played yet</h3>
            <p>Play a few tracks and this page fills up with what you listen to,
               when, and how much.</p>
            <a class="btn primary" href="#/search">${icon('search', 15)} Find something</a>
          </div>`;
        return;
      }
      body.appendChild(summaryCards(s));
      body.appendChild(dayCard(s.by_day));
      body.appendChild(hourCard(s.by_hour));
      body.appendChild(topArtistsCard(s.top_artists));
      body.appendChild(topTracksCard(s.top_tracks));
    } catch (e) {
      body.innerHTML = `
        <div class="empty">
          <span class="empty-ico">${icon('alert', 40)}</span>
          <h3>Couldn't load stats</h3>
          <p>${escapeHtml(String(e.detail || e.message))}</p>
          <button class="btn ghost" id="st-retry">Try again</button>
        </div>`;
      body.querySelector('#st-retry').onclick = loadStats;
    }
  }

  await loadStats();
  return {};
}

// ── summary cards ───────────────────────────────────────────────────

function summaryCards(s) {
  const hours = s.seconds / 3600;
  const timeLabel = hours >= 100
    ? `${Math.round(hours)} h`
    : hours >= 10
      ? `${hours.toFixed(1)} h`
      : `${Math.round(s.seconds / 60)} min`;
  const wrap = document.createElement('section');
  wrap.className = 'section';
  wrap.innerHTML = `
    <div class="stat-cards">
      ${statCard(icon('play', 20, true), s.plays.toLocaleString(), 'plays', daysWord(s.days))}
      ${statCard(icon('clock', 20), timeLabel, 'listening time', 'estimated from track lengths')}
      ${statCard(icon('music', 20), s.tracks.toLocaleString(), 'different tracks', `out of ${s.days} days`)}
      ${statCard(icon('user', 20), s.artists.toLocaleString(), 'artists', 'distinct names')}
    </div>`;
  return wrap;
}

function statCard(ico, value, label, sub) {
  return `
    <div class="stat-card">
      <span class="stat-ico">${ico}</span>
      <div>
        <div class="stat-value">${escapeHtml(String(value))}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-sub">${escapeHtml(sub)}</div>
      </div>
    </div>`;
}

function daysWord(days) {
  return `over the last ${days} days`;
}

// consecutive days with at least one play, ending today or yesterday
function listeningStreak(byDay) {
  if (!byDay || !byDay.length) return 0;
  const played = new Set(byDay.filter(d => d.plays > 0).map(d => d.day));
  const dayMs = 86400000;
  // local dates — the server buckets by its own local day too
  const iso = (dt) => {
    const d = new Date(dt);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // walk back from today; allow the streak to start yesterday
  let cursor = new Date();
  if (!played.has(iso(cursor))) cursor = new Date(Date.now() - dayMs);
  if (!played.has(iso(cursor))) return 0;
  let streak = 0;
  while (played.has(iso(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - dayMs);
  }
  return streak;
}

// ── per-day bar chart ───────────────────────────────────────────────

function dayCard(byDay) {
  const sec = document.createElement('section');
  sec.className = 'section';
  if (!byDay || !byDay.length) return sec;
  const maxMin = Math.max(...byDay.map(d => d.seconds / 60), 1);
  const W = 760, H = 170, PT = 14, PB = 26, PL = 34, PR = 8;
  const innerW = W - PL - PR, innerH = H - PT - PB;
  const bw = innerW / byDay.length;
  const gridLines = [1, 0.5, 0];
  const dayLabel = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const fmtMin = (secs) => secs >= 5400 ? `${Math.round(secs / 3600)}h` : `${Math.round(secs / 60)}m`;
  const labelEvery = Math.max(1, Math.ceil(byDay.length / 8));

  let bars = '';
  byDay.forEach((d, i) => {
    const mins = d.seconds / 60;
    const h = mins > 0 ? Math.max(3, (mins / maxMin) * innerH) : 1.5;
    const x = PL + i * bw + bw * 0.16;
    const y = PT + innerH - h;
    const last = i === byDay.length - 1;
    bars += `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${h.toFixed(1)}" rx="2.5"
            class="chart-bar${last ? ' today' : ''}">
        <title>${d.day} — ${d.plays} play${d.plays === 1 ? '' : 's'} · ${fmtMin(d.seconds)}</title>
      </rect>`;
  });
  let grid = '';
  gridLines.forEach((g) => {
    const y = PT + innerH * (1 - g);
    grid += `
      <line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" class="chart-grid"/>
      <text x="${PL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="chart-ttext">${fmtMin(maxMin * 60 * g)}</text>`;
  });
  let labels = '';
  byDay.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== byDay.length - 1) return;
    labels += `<text x="${(PL + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="chart-ttext">${dayLabel(d.day)}</text>`;
  });

  const streak = listeningStreak(byDay);
  sec.innerHTML = `
    <div class="section-head-row">
      <h2>${icon('chart', 20)} &nbsp;Listening by day</h2>
      <span class="faint" style="font-size:12px">${streak ? `${streak}-day streak 🔥 · ` : ''}peak ${fmtMin(maxMin * 60)} · minutes estimated from track lengths</span>
    </div>
    <div class="card chart-card">
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Listening minutes per day">
        ${grid}${bars}${labels}
      </svg>
    </div>`;
  return sec;
}

// ── hour-of-day chart ───────────────────────────────────────────────

function hourCard(byHour) {
  const sec = document.createElement('section');
  sec.className = 'section';
  if (!byHour || !byHour.length) return sec;
  const max = Math.max(...byHour.map(h => h.plays), 1);
  const peak = byHour.reduce((a, b) => (b.plays > a.plays ? b : a), byHour[0]);
  const W = 760, H = 150, PT = 14, PB = 24, PL = 26, PR = 8;
  const innerW = W - PL - PR, innerH = H - PT - PB;
  const bw = innerW / 24;

  let bars = '';
  byHour.forEach((h, i) => {
    const bh = h.plays > 0 ? Math.max(3, (h.plays / max) * innerH) : 1.5;
    const x = PL + i * bw + bw * 0.18;
    bars += `
      <rect x="${x.toFixed(1)}" y="${(PT + innerH - bh).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5"
            class="chart-bar hour${h.hour === peak.hour ? ' today' : ''}">
        <title>${String(h.hour).padStart(2, '0')}:00 — ${h.plays} play${h.plays === 1 ? '' : 's'}</title>
      </rect>`;
  });
  const labels = [0, 6, 12, 18, 23].map(hh => `
    <text x="${(PL + hh * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart-ttext">${hh}</text>`).join('');

  const peakLabel = peak.plays
    ? `you're a ${peak.hour < 6 ? 'night owl 🌙' : peak.hour < 12 ? 'morning person ☀️' : peak.hour < 18 ? 'afternoon listener 🎧' : 'evening listener 🌆'}`
    : '';

  sec.innerHTML = `
    <div class="section-head-row">
      <h2>${icon('clock', 20)} &nbsp;Your listening clock</h2>
      <span class="faint" style="font-size:12px">${peakLabel}</span>
    </div>
    <div class="card chart-card">
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Plays per hour of day">
        <line x1="${PL}" y1="${PT + innerH}" x2="${W - PR}" y2="${PT + innerH}" class="chart-grid"/>
        ${bars}${labels}
      </svg>
    </div>`;
  return sec;
}

// ── top artists ─────────────────────────────────────────────────────

function topArtistsCard(artists) {
  const sec = document.createElement('section');
  sec.className = 'section';
  if (!artists || !artists.length) return sec;
  const max = artists[0].plays || 1;
  const rows = artists.map((a, i) => `
    <button class="rank-row" data-seed="${escapeAttr(a.artist)}" title="Play radio for ${escapeAttr(a.artist)}">
      <span class="rank-num">${i + 1}</span>
      <span class="rank-art" aria-hidden="true">${escapeHtml(a.artist.slice(0, 1).toUpperCase())}</span>
      <span class="grow" style="min-width:0">
        <span class="rank-name ellipsis" style="display:block"></span>
        <span class="rank-bar-wrap"><span class="rank-bar" style="width:${Math.round((a.plays / max) * 100)}%"></span></span>
      </span>
      <span class="rank-meta">${a.plays} play${a.plays === 1 ? '' : 's'} · ${a.tracks} track${a.tracks === 1 ? '' : 's'}</span>
      <span class="rank-ico">${icon('radio', 15)}</span>
    </button>`).join('');
  sec.innerHTML = `
    <div class="section-head-row">
      <h2>${icon('user', 20)} &nbsp;Top artists</h2>
      <span class="faint" style="font-size:12px">click to start a radio mix</span>
    </div>
    <div class="card" style="padding:6px 10px">${rows}</div>`;
  // textContent after the fact — names can contain markup-looking chars
  sec.querySelectorAll('.rank-row').forEach((row, i) => {
    row.querySelector('.rank-name').textContent = artists[i].artist;
    row.onclick = () => {
      location.hash = `#/radio?seed=${encodeURIComponent(artists[i].artist)}&auto=1`;
    };
  });
  return sec;
}

// ── top tracks ──────────────────────────────────────────────────────

function topTracksCard(tracks) {
  const sec = document.createElement('section');
  sec.className = 'section';
  if (!tracks || !tracks.length) return sec;
  sec.innerHTML = `
    <div class="section-head-row">
      <h2>${icon('music', 20)} &nbsp;Top tracks</h2>
    </div>
    <div class="card" style="padding:6px 10px" id="st-toptracks"></div>`;
  const host = sec.querySelector('#st-toptracks');
  const max = tracks[0].plays || 1;
  tracks.forEach((t, i) => {
    const row = document.createElement('button');
    row.className = 'rank-row track';
    row.innerHTML = `
      <span class="rank-num">${i + 1}</span>
      <img class="rank-cover" src="${escapeHtml(thumbUrl(t, 'mq'))}" alt="" loading="lazy" onerror="__thumbErr(this)">
      <span class="grow" style="min-width:0;text-align:left">
        <span class="rank-name ellipsis" style="display:block"></span>
        <span class="rank-sub ellipsis" style="display:block"></span>
        <span class="rank-bar-wrap"><span class="rank-bar" style="width:${Math.round((t.plays / max) * 100)}%"></span></span>
      </span>
      <span class="rank-meta">${t.plays}× · ${fmtTime(t.duration || 0)}</span>
      <span class="rank-ico">${icon('play', 15, true)}</span>`;
    row.querySelector('.rank-name').textContent = t.title || t.id;
    row.querySelector('.rank-sub').textContent = t.artist || '';
    row.onclick = () => {
      rememberTracks(tracks);
      import('../player.js').then(p => p.playTracks(tracks, i));
    };
    host.appendChild(row);
  });
  return sec;
}

// ── helpers ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }
