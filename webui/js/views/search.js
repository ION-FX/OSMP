// Search — debounced live YouTube search, recent searches, genre browse chips.

import { api, extractVideoId, isImportLink } from '../api.js';
import { load, persist, rememberTracks } from '../store.js';
import { icon } from '../components/icons.js';
import { toastErr, toast } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';

const BROWSE = [
  'lofi', 'synthwave', 'jazz piano', 'classical focus', 'indie rock', 'k-pop',
  'afrobeats', 'techno', 'ambient sleep', 'latin hits', 'metal', 'hip hop 90s',
  'funk', 'post rock', 'arabic music', 'bollywood hits',
];

let debounceT = null;
let abortCtl = null;

export async function mount(root, params) {
  root.innerHTML = `
    <div class="view-head" style="flex-direction:column;align-items:stretch;gap:14px">
      <h1>Search</h1>
      <div style="position:relative;max-width:640px">
        <span id="sr-ico" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-faint);display:flex"></span>
        <input id="sr-input" class="input" type="search" autocomplete="off"
               placeholder="Songs, artists, moods — or paste a YouTube link…"
               style="padding-left:44px;padding-right:44px;height:50px;border-radius:26px">
        <button id="sr-clear" class="icon-btn sm hidden"
                style="position:absolute;right:8px;top:50%;transform:translateY(-50%)"></button>
      </div>
      <div id="sr-recent" class="chip-row"></div>
    </div>
    <div id="sr-results"></div>
    <div id="sr-browse" class="section">
      <div class="section-head-row"><h2>Browse</h2></div>
      <div class="chip-row" id="sr-browse-chips"></div>
    </div>
  `;

  const input = root.querySelector('#sr-input');
  const results = root.querySelector('#sr-results');
  const clearBtn = root.querySelector('#sr-clear');
  root.querySelector('#sr-ico').innerHTML = icon('search', 19);
  clearBtn.innerHTML = icon('close', 15);

  // recent searches
  const renderRecent = () => {
    const recent = load('recentSearches', []);
    const host = root.querySelector('#sr-recent');
    host.innerHTML = recent.length
      ? recent.map(q => `<button class="chip" data-q="${encodeURIComponent(q)}">${icon('clock', 14)} ${escapeHtml(q)}</button>`).join('')
        + `<button class="chip" data-clear="1" style="opacity:.7">Clear</button>`
      : '';
    host.querySelectorAll('[data-q]').forEach(c => {
      c.onclick = () => { input.value = decodeURIComponent(c.dataset.q); runSearch(input.value); };
    });
    host.querySelector('[data-clear]')?.addEventListener('click', () => {
      persist('recentSearches', []); renderRecent();
    });
  };
  renderRecent();

  // browse chips
  const browse = root.querySelector('#sr-browse-chips');
  BROWSE.forEach(q => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = q;
    c.onclick = () => { input.value = q; runSearch(q); };
    browse.appendChild(c);
  });

  const saveRecent = (q) => {
    let recent = load('recentSearches', []).filter(x => x !== q);
    recent.unshift(q);
    persist('recentSearches', recent.slice(0, 8));
    renderRecent();
  };

  async function runSearch(q) {
    q = q.trim();
    clearBtn.classList.toggle('hidden', !q);
    if (!q) {
      results.innerHTML = '';
      root.querySelector('#sr-browse').style.display = '';
      return;
    }
    root.querySelector('#sr-browse').style.display = 'none';
    saveRecent(q);

    // playlist/album/channel link → import view; single video → jump to the track
    if (isImportLink(q)) {
      results.innerHTML = `<div class="section-head-row"><h2>Opening importer for “${escapeHtml(q.slice(0, 48))}”…</h2></div>`;
      location.hash = `#/import?url=${encodeURIComponent(q)}`;
      return;
    }
    const vid = extractVideoId(q);
    if (vid) {
      results.innerHTML = `<div class="section-head-row"><h2>From link</h2></div><div id="sr-direct"></div>`;
      skeletonTracklist(results.querySelector('#sr-direct'), 1);
      try {
        const t = await api.track(vid);
        rememberTracks([t]);
        renderTracklist(results.querySelector('#sr-direct'), [t], {});
      } catch (e) {
        results.querySelector('#sr-direct').innerHTML =
          `<div class="empty"><h3>Link not playable</h3><p>${escapeHtml(String(e.detail || e.message))}</p></div>`;
      }
      return;
    }

    skeletonTracklist(results, 8);
    abortCtl?.abort();
    abortCtl = new AbortController();
    try {
      const [data, mine] = await Promise.all([api.search(q, 24), localMatches(q)]);
      rememberTracks(data.results);
      rememberTracks(mine);
      results.innerHTML = `
        ${mine.length ? `
          <div class="section-head-row">
            <h2>From your library</h2>
            <span class="faint" style="font-size:12.5px">${mine.length} of your track${mine.length === 1 ? '' : 's'}</span>
          </div>
          <div id="sr-mine" style="margin-bottom:26px"></div>` : ''}
        <div class="section-head-row">
          <h2>Results for “${escapeHtml(q)}”</h2>
          <span class="faint" style="font-size:12.5px">${data.results.length} tracks</span>
        </div>
        <div id="sr-list"></div>`;
      if (mine.length) renderTracklist(results.querySelector('#sr-mine'), mine, {});
      if (!data.results.length && !mine.length) {
        results.querySelector('#sr-list').innerHTML =
          `<div class="empty"><h3>No results</h3><p>Try different words, or search by artist + title.</p></div>`;
        return;
      }
      if (!data.results.length) {
        results.querySelector('#sr-list').innerHTML = '';
        return;
      }
      renderTracklist(results.querySelector('#sr-list'), data.results, {});
    } catch (e) {
      if (e.name === 'AbortError') return;
      results.innerHTML = '';
      toastErr(e.detail || 'Search failed');
    }
  }

  // your own uploads match too — the library list is cached for a minute
  let libCache = null;
  let libCacheAt = 0;
  async function localMatches(q) {
    if (!libCache || Date.now() - libCacheAt > 60000) {
      try {
        libCache = (await api.library(false)).tracks;
        libCacheAt = Date.now();
      } catch { libCache = []; }
    }
    const ql = q.toLowerCase();
    return libCache.filter(t =>
      (t.title || '').toLowerCase().includes(ql) ||
      (t.artist || '').toLowerCase().includes(ql)).slice(0, 5);
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    const q = input.value;
    clearBtn.classList.toggle('hidden', !q);
    debounceT = setTimeout(() => runSearch(q), 380);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounceT); runSearch(input.value); }
  });
  clearBtn.onclick = () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    results.innerHTML = '';
    root.querySelector('#sr-browse').style.display = '';
    input.focus();
  };

  if (params.q) {
    input.value = params.q;
    runSearch(params.q);
  } else {
    setTimeout(() => input.focus(), 120);
  }
}

export function unmount() {
  clearTimeout(debounceT);
  abortCtl?.abort();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
