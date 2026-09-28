// Home — greeting hero, quick-start moods, recent plays, downloads, playlists.

import { api, thumbUrl, fmtDurLong, fmtBytes } from '../api.js';
import { get } from '../store.js';
import { icon } from '../components/icons.js';
import { skeletonCards } from '../components/tracklist.js';
import { renderTracklist } from '../components/tracklist.js';
import { refreshPlaylists } from '../actions.js';

const MOODS = [
  { label: 'Chill lofi', seed: 'lofi hip hop relaxing', icon: 'waves' },
  { label: 'Deep focus', seed: 'deep focus ambient instrumental', icon: 'disc' },
  { label: 'Synthwave', seed: 'synthwave night drive', icon: 'zap' },
  { label: 'Jazz evening', seed: 'smooth jazz evening', icon: 'star' },
  { label: 'Workout', seed: 'high energy workout', icon: 'zap' },
  { label: '80s classics', seed: '80s hits', icon: 'music' },
  { label: 'Indie folk', seed: 'indie folk acoustic', icon: 'waves' },
  { label: 'Sleep', seed: 'sleep ambient piano calm', icon: 'moon' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export async function mount(root) {
  root.innerHTML = `
    <section class="hero">
      <h1 id="hm-greet"></h1>
      <p>Your self-hosted stream · YouTube-backed · offline-ready.</p>
      <div class="chip-row hero-chips" id="hm-moods"></div>
    </section>

    <section class="section" id="hm-recent-sec" style="display:none">
      <div class="section-head-row"><h2>Jump back in</h2></div>
      <div id="hm-recent"></div>
    </section>

    <section class="section" id="hm-foryou-sec" style="display:none">
      <div class="section-head-row">
        <h2>Made for you</h2>
        <a class="text-btn" href="#/stats">Your stats →</a>
      </div>
      <div class="card-grid" id="hm-foryou"></div>
    </section>

    <section class="section">
      <div class="section-head-row">
        <h2>Quick mixes</h2>
        <a class="text-btn" href="#/radio">Open radio →</a>
      </div>
      <div class="card-grid" id="hm-mixes"></div>
    </section>

    <section class="section" id="hm-pl-sec" style="display:none">
      <div class="section-head-row">
        <h2>Your playlists</h2>
        <a class="text-btn" href="#/library">Library →</a>
      </div>
      <div class="card-grid" id="hm-playlists"></div>
    </section>

    <section class="section" id="hm-dl-sec" style="display:none">
      <div class="section-head-row">
        <h2>Downloaded</h2>
        <a class="text-btn" href="#/library">Manage →</a>
      </div>
      <div id="hm-downloads"></div>
    </section>
  `;

  root.querySelector('#hm-greet').textContent = `${greeting()} ✦`;

  // mood chips
  const moods = root.querySelector('#hm-moods');
  MOODS.slice(0, 5).forEach(m => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = `${icon(m.icon, 15)} ${m.label}`;
    chip.onclick = () => { location.hash = `#/radio?seed=${encodeURIComponent(m.seed)}&auto=1`; };
    moods.appendChild(chip);
  });

  // quick mixes (radio presets as cards)
  const mixes = root.querySelector('#hm-mixes');
  skeletonCards(mixes, 6);
  const mixSeeds = MOODS.slice(0, 6);
  mixes.innerHTML = '';
  mixSeeds.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-cover">
        <div class="cover-fallback" style="background:linear-gradient(135deg,
          hsl(${(i * 57 + 160) % 360} 70% 42%), hsl(${(i * 57 + 240) % 360} 75% 55%))">
          ${icon(m.icon, 40)}
        </div>
        <button class="card-play" title="Generate radio">${icon('play', 18, true)}</button>
      </div>
      <div class="card-title"></div>
      <div class="card-sub">Radio mix</div>`;
    card.querySelector('.card-title').textContent = m.label;
    card.onclick = () => { location.hash = `#/radio?seed=${encodeURIComponent(m.seed)}&auto=1`; };
    mixes.appendChild(card);
  });

  // dynamic data
  try {
    const home = await api.home();

    if (home.recent && home.recent.length) {
      root.querySelector('#hm-recent-sec').style.display = '';
      renderTracklist(root.querySelector('#hm-recent'), home.recent.slice(0, 8), {});
    }

    // "Made for you" — artist mixes derived from this account's plays
    try {
      const mx = await api.mixes();
      if (mx.mixes && mx.mixes.length) {
        root.querySelector('#hm-foryou-sec').style.display = '';
        const host = root.querySelector('#hm-foryou');
        mx.mixes.slice(0, 6).forEach((m, i) => {
          const card = document.createElement('div');
          card.className = 'card foryou-card';
          card.innerHTML = `
            <div class="card-cover">
              <div class="cover-fallback" style="background:linear-gradient(135deg,
                hsl(${(i * 63 + 200) % 360} 62% 30%), hsl(${(i * 63 + 300) % 360} 72% 48%))">
                <span class="foryou-initial">${escapeHtml((m.seed || '?').slice(0, 1).toUpperCase())}</span>
              </div>
              <button class="card-play" title="Generate mix">${icon('play', 18, true)}</button>
            </div>
            <div class="card-title ellipsis"></div>
            <div class="card-sub"></div>`;
          card.querySelector('.card-title').textContent = m.title;
          card.querySelector('.card-sub').textContent = m.subtitle || 'radio mix';
          card.onclick = () => {
            location.hash = `#/radio?seed=${encodeURIComponent(m.seed)}&auto=1`;
          };
          host.appendChild(card);
        });
      }
      // downloaded but never played — give them a shelf
      if (mx.fresh && mx.fresh.length >= 3) {
        const sec = document.createElement('section');
        sec.className = 'section';
        sec.innerHTML = `
          <div class="section-head-row">
            <h2>Downloaded, never played</h2>
            <a class="text-btn" href="#/library">Library →</a>
          </div>
          <div class="row gap-m" id="hm-fresh" style="flex-wrap:wrap;gap:10px"></div>`;
        const freshHost = sec.querySelector('#hm-fresh');
        mx.fresh.slice(0, 6).forEach(t => {
          const chip = document.createElement('button');
          chip.className = 'chip';
          chip.title = `${t.title || ''} — ${t.artist || ''}`;
          const label = document.createElement('span');
          label.className = 'ellipsis';
          label.style.cssText = 'display:inline-block;max-width:220px';
          label.textContent = t.title || t.id;
          chip.appendChild(label);
          chip.onclick = () => {
            import('../player.js').then(p => p.playTracks([t], 0));
          };
          freshHost.appendChild(chip);
        });
        root.querySelector('#hm-foryou-sec').after(sec);
      }
    } catch { /* mixes are decorative — never block the page */
    }

    if (home.playlists && home.playlists.length) {
      root.querySelector('#hm-pl-sec').style.display = '';
      const host = root.querySelector('#hm-playlists');
      home.playlists.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div class="card-cover">
            <div class="cover-fallback" style="background:linear-gradient(135deg,
              hsl(${(i * 73 + 178) % 360} 55% 34%), hsl(${(i * 73 + 258) % 360} 65% 50%))">
              ${icon(p.name === 'Liked' ? 'heart' : 'music', 38, p.name === 'Liked')}
            </div>
            <button class="card-play">${icon('play', 18, true)}</button>
          </div>
          <div class="card-title ellipsis"></div>
          <div class="card-sub">${p.track_count} tracks · ${fmtDurLong(p.total_duration)}</div>`;
        card.querySelector('.card-title').textContent = p.name;
        card.onclick = () => { location.hash = `#/playlist/${p.id}`; };
        host.appendChild(card);
      });
    }

    if (home.downloads && home.downloads.length) {
      root.querySelector('#hm-dl-sec').style.display = '';
      renderTracklist(root.querySelector('#hm-downloads'), home.downloads, {});
    }
  } catch (e) {
    console.warn('[home] data load failed', e);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
