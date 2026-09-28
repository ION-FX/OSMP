// Radio — algorithmic playlist generation + optional LLM curator.

import { api, isImportLink } from '../api.js';
import { get, load, persist, rememberTracks } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';
import { newPlaylistDialog } from '../actions.js';

const PRESETS = ['lofi hip hop', 'synthwave', 'jazz piano', '90s hip hop', 'ambient sleep', 'indie folk'];

// seeds the "Surprise me" shuffle picks from — moods, scenes and decades
const SURPRISE = [
  'lofi hip hop', 'synthwave night drive', 'jazz piano evening', '90s hip hop',
  'ambient sleep rain', 'indie folk acoustic', 'french cafe jazz', 'desert blues',
  'city pop 1984', 'post punk 2009', 'shoegaze essentials', 'afrobeats summer',
  'bossa nova morning', 'drum and bass liquid', 'trip hop nocturnal',
  'baroque classical focus', 'gospel choir energy', 'reggae dub roots',
  'dark techno warehouse', 'vaporgrid mallsoft', 'celtic instrumentals',
  'movie scores epics', 'salsa dura 70s', 'k-pop girl group hits',
  '70s funk groove', '80s synth pop gems', '2000s pop punk', '2010s indie dance',
];

export async function mount(root, params) {
  root.innerHTML = `
    <div class="view-head"><h1>${icon('radio', 26)} &nbsp;Radio</h1></div>

    <section class="hero" style="margin-bottom:22px">
      <h1 style="font-size:clamp(20px,2.6vw,26px)">Infinite playlists, no API key</h1>
      <p>Seeds a track, artist or mood through YouTube's own recommendation graph,
         then shapes it: dedupe, artist spread, relevance ranking.</p>
      <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="position:relative;flex:1;min-width:240px">
          <input id="rd-seed" class="input" style="height:52px;border-radius:26px;padding:0 22px"
                 placeholder="Artist, song, mood… or paste a YouTube link" maxlength="200">
        </div>
        <select id="rd-count" class="select" style="width:auto;border-radius:26px;height:52px;padding:0 18px">
          <option value="15">15 tracks</option>
          <option value="25" selected>25 tracks</option>
          <option value="40">40 tracks</option>
          <option value="60">60 tracks</option>
        </select>
        <button id="rd-go" class="btn primary lg">${icon('zap', 17)} Generate</button>
        <button id="rd-surprise" class="btn ghost lg" title="Pick a seed at random and go">${icon('sparkles', 17)} Surprise me</button>
      </div>
      <div class="chip-row" style="margin-top:16px" id="rd-presets"></div>
      <div id="rd-history-chips" class="chip-row" style="margin-top:10px"></div>
    </section>

    <div id="rd-results" class="section"></div>

    <section class="section">
      <div class="section-head-row">
        <h2>${icon('sparkles', 20)} &nbsp;AI Curator <span class="nav-badge beta" style="vertical-align:middle">LLM</span></h2>
        <span id="rd-llm-status" class="faint" style="font-size:12px"></span>
      </div>
      <div class="card" style="cursor:default;background:var(--bg-2)">
        <p class="dim" style="font-size:13.5px;margin-bottom:14px">
          Describe the vibe in plain words — a configured LLM (OpenAI, OpenRouter, Ollama, anything
          OpenAI-compatible) designs the tracklist and OSMP resolves every pick on YouTube.
        </p>
        <textarea id="rd-prompt" class="textarea" rows="2"
          placeholder="e.g. A rainy Tokyo night in 1984 — city pop into soft synthwave, mellow but driving"></textarea>
        <div class="row gap-m" style="margin-top:12px;flex-wrap:wrap">
          <button id="rd-llm-go" class="btn primary">${icon('sparkles', 16)} Curate with AI</button>
          <a class="btn ghost" href="#/settings">${icon('key', 15)} Configure LLM</a>
        </div>
        <div id="rd-llm-error" class="hidden" style="margin-top:12px;color:hsl(38 90% 62%);font-size:13px"></div>
      </div>
    </section>
  `;

  const seedInput = root.querySelector('#rd-seed');
  const countSel = root.querySelector('#rd-count');
  const goBtn = root.querySelector('#rd-go');
  const results = root.querySelector('#rd-results');

  // presets + history chips
  const presets = root.querySelector('#rd-presets');
  PRESETS.forEach(p => {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = p;
    c.onclick = () => { seedInput.value = p; generate(p); };
    presets.appendChild(c);
  });
  const renderHistory = () => {
    const hist = load('radioHistory', []);
    const host = root.querySelector('#rd-history-chips');
    host.innerHTML = hist.length ? '<span class="faint" style="font-size:12px;align-self:center">Recent:</span>' : '';
    hist.slice(0, 6).forEach(h => {
      const c = document.createElement('button');
      c.className = 'chip'; c.style.opacity = '.85';
      c.textContent = h;
      c.onclick = () => { seedInput.value = h; generate(h); };
      host.appendChild(c);
    });
  };
  renderHistory();

  // LLM status
  const cfg = get('config') || {};
  root.querySelector('#rd-llm-status').textContent = cfg.llm_configured
    ? '● connected' : '○ not configured';
  root.querySelector('#rd-llm-status').style.color = cfg.llm_configured
    ? 'hsl(140 70% 55%)' : 'var(--text-faint)';

  root.querySelector('#rd-llm-go').onclick = () => llmCurate();
  root.querySelector('#rd-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) llmCurate();
  });

  goBtn.onclick = () => generate(seedInput.value);
  seedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') generate(seedInput.value); });
  root.querySelector('#rd-surprise').onclick = () => {
    const pick = SURPRISE[Math.floor(Math.random() * SURPRISE.length)];
    seedInput.value = pick;
    toast(`Rolled “${pick}” 🎲`, { icon: 'sparkles', timeout: 3000 });
    generate(pick);
  };

  async function llmCurate() {
    const prompt = root.querySelector('#rd-prompt').value.trim();
    const errBox = root.querySelector('#rd-llm-error');
    errBox.classList.add('hidden');
    if (!prompt) { toast('Describe the vibe first ✍️'); return; }
    if (!cfg.llm_configured) {
      errBox.textContent = 'No LLM configured yet — add a base URL / API key in Settings (works with OpenAI, OpenRouter, Ollama, LM Studio…).';
      errBox.classList.remove('hidden');
      return;
    }
    const btn = root.querySelector('#rd-llm-go');
    btn.disabled = true;
    btn.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 16)}</span> Dreaming up a mix…`;
    results.innerHTML = '';
    try {
      const data = await api.llmCurate(prompt, 20);
      rememberTracks(data.tracks);
      renderResult(results, data.tracks, {
        title: data.title,
        subtitle: data.notes || `Curated by ${data.model}`,
        kind: 'AI mix',
        defaultName: data.title,
      });
      if (data.unresolved?.length) {
        toast(`${data.unresolved.length} picks couldn't be found on YouTube`, { icon: 'info' });
      }
      toastOk('AI mix ready ✨');
    } catch (e) {
      errBox.textContent = e.status === 428
        ? 'No LLM configured — open Settings → AI Curator.'
        : (e.detail || e.message || 'LLM request failed');
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('sparkles', 16)} Curate with AI`;
    }
  }

  async function generate(seed) {
    seed = (seed || '').trim();
    if (!seed) { toast('Give the radio a seed — artist, song or mood'); seedInput.focus(); return; }
    // a pasted playlist/channel link belongs to the importer, not radio
    if (isImportLink(seed)) {
      toast('Opening the importer — playlists aren’t radio seeds', { icon: 'info' });
      location.hash = `#/import?url=${encodeURIComponent(seed)}`;
      return;
    }
    goBtn.disabled = true;
    goBtn.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 16)}</span> Tuning…`;
    results.innerHTML = `
      <div class="section-head-row"><h2>Building “${escapeAttr(seed)}” radio…</h2></div>`;
    skeletonTracklist(results, 10);
    try {
      const data = await api.radio(seed, +countSel.value);
      rememberTracks(data.tracks);
      renderResult(results, data.tracks, {
        title: data.seed,
        subtitle: `${data.count} tracks · generated from YouTube's recommendation graph`,
        kind: data.seed_type === 'track' ? 'Track radio' : 'Mood radio',
        defaultName: `Radio: ${data.seed}`.slice(0, 60),
      });
      // save to history
      const hist = load('radioHistory', []).filter(h => h !== seed);
      hist.unshift(seed);
      persist('radioHistory', hist.slice(0, 8));
      renderHistory();
    } catch (e) {
      results.innerHTML = `
        <div class="empty">
          <span class="empty-ico">${icon('alert', 40)}</span>
          <h3>Radio failed</h3>
          <p>${escapeAttr(e.detail || e.message || 'Unknown error')}</p>
        </div>`;
    } finally {
      goBtn.disabled = false;
      goBtn.innerHTML = `${icon('zap', 17)} Generate`;
    }
  }

  // auto-generate when arriving with ?seed=...&auto=1
  if (params.seed) {
    seedInput.value = params.seed;
    if (params.auto) generate(params.seed);
  }

  return {};
}

function renderResult(host, tracks, { title, subtitle, kind, defaultName }) {
  host.innerHTML = `
    <div class="detail-head" style="margin-top:6px">
      <div class="detail-meta">
        <div class="detail-kind">${escapeAttr(kind)}</div>
        <h1>${escapeAttr(title)}</h1>
        <div class="detail-sub">${escapeAttr(subtitle)}</div>
        <div class="detail-actions" style="margin-top:16px">
          <button class="play-big" id="rr-play" title="Play now">${icon('play', 22, true)}</button>
          <button class="btn ghost" id="rr-shuffle">${icon('shuffle', 15)} Shuffle</button>
          <button class="btn ghost" id="rr-save">${icon('playlist-plus', 15)} Save playlist</button>
          <button class="btn ghost" id="rr-queue">${icon('queue', 15)} Queue all</button>
        </div>
      </div>
    </div>
    <div id="rr-list"></div>`;
  renderTracklist(host.querySelector('#rr-list'), tracks, {});

  host.querySelector('#rr-play').onclick = () =>
    import('../player.js').then(p => p.playTracks(tracks, 0));
  host.querySelector('#rr-shuffle').onclick = () =>
    import('../player.js').then(p => p.playTracks(tracks, 0, { shuffle: true, random: true }));
  host.querySelector('#rr-queue').onclick = () =>
    import('../player.js').then(p => { tracks.forEach(t => p.enqueue(t)); toast(`Queued ${tracks.length} tracks`, { icon: 'queue' }); });
  host.querySelector('#rr-save').onclick = async () => {
    const pl = await newPlaylistDialog();
    if (pl) {
      try {
        await api.addToPlaylist(pl.id, tracks.map(t => ({
          id: t.id, title: t.title, artist: t.artist,
          duration: t.duration, thumbnail: t.thumbnail,
        })));
        toastOk(`Saved ${tracks.length} tracks to “${pl.name}”`, {
          action: { label: 'Open', onClick: () => { location.hash = `#/playlist/${pl.id}`; } },
        });
        import('../actions.js').then(a => a.refreshPlaylists());
      } catch (e) { toastErr('Save failed'); }
    }
  };
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
