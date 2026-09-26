// Library — downloads (server + on-device), playlists grid, storage stats.

import { api, fmtDurLong, fmtBytes } from '../api.js';
import { get, set } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist, skeletonCards } from '../components/tracklist.js';
import { refreshPlaylists, newPlaylistDialog, removeDownload } from '../actions.js';
import { bridge } from '../player.js';

export async function mount(root) {
  root.innerHTML = `
    <div class="view-head">
      <h1>Library</h1>
      <span class="spacer"></span>
      <button class="btn primary" id="lb-new">${icon('plus', 16)} New playlist</button>
    </div>

    <section class="section">
      <div class="section-head-row">
        <h2>Playlists</h2>
        <span class="faint" id="lb-pl-count" style="font-size:12.5px"></span>
      </div>
      <div class="card-grid" id="lb-playlists"></div>
    </section>

    <section class="section">
      <div class="section-head-row">
        <h2>Downloads</h2>
        <span class="faint" id="lb-dl-stats" style="font-size:12.5px"></span>
      </div>
      <div id="lb-native-note" class="hidden" style="margin-bottom:12px">
        <span class="chip on" style="cursor:default">${icon('download-check', 14)} On-device downloads active</span>
      </div>
      <div id="lb-downloads"></div>
    </section>
  `;

  root.querySelector('#lb-new').onclick = () => newPlaylistDialog();

  if (bridge()?.isDownloaded) root.querySelector('#lb-native-note').classList.remove('hidden');

  await Promise.all([renderPlaylists(), renderDownloads()]);
}

async function renderPlaylists() {
  await refreshPlaylists();
  const pls = get('playlists');
  const host = document.getElementById('lb-playlists');
  document.getElementById('lb-pl-count').textContent = `${pls.length} playlists`;
  if (!pls.length) {
    host.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <span class="empty-ico">${icon('playlist-plus', 40)}</span>
        <h3>No playlists yet</h3>
        <p>Create one, save a radio mix, or heart tracks to build your Liked list.</p>
      </div>`;
    return;
  }
  host.innerHTML = '';
  pls.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-cover">
        <div class="cover-fallback" style="background:linear-gradient(135deg,
          hsl(${(i * 73 + 178) % 360} 55% 34%), hsl(${(i * 73 + 258) % 360} 65% 50%))">
          ${icon(p.name === 'Liked' ? 'heart' : 'music', 40, p.name === 'Liked')}
        </div>
        <button class="card-play" title="Open">${icon('play', 18, true)}</button>
      </div>
      <div class="card-title ellipsis"></div>
      <div class="card-sub">${p.track_count} tracks · ${fmtDurLong(p.total_duration)}</div>`;
    card.querySelector('.card-title').textContent = p.name;
    card.onclick = () => { location.hash = `#/playlist/${p.id}`; };
    host.appendChild(card);
  });
}

async function renderDownloads() {
  const host = document.getElementById('lb-downloads');
  skeletonTracklist(host, 4);

  let tracks = [];
  let totalSize = 0;

  // server downloads
  try {
    const data = await api.library(true);
    tracks = data.tracks;
    totalSize = tracks.reduce((s, t) => s + (t.file_size || 0), 0);
  } catch (e) {
    console.warn('[library] server downloads failed', e);
  }

  // native (Android) downloads
  const b = bridge();
  if (b?.listDownloads) {
    try {
      const native = JSON.parse(b.listDownloads() || '[]');
      const have = new Set(tracks.map(t => t.id));
      for (const n of native) {
        totalSize += n.size || 0;
        if (!have.has(n.id)) {
          tracks.push({
            id: n.id, title: n.title || n.id, artist: n.artist || 'Unknown',
            duration: n.duration, thumbnail: n.thumbnail, offline: true,
          });
        } else {
          const t = tracks.find(x => x.id === n.id);
          t.offline = true;
        }
      }
    } catch (e) { console.warn('[library] native list failed', e); }
  }

  document.getElementById('lb-dl-stats').textContent =
    tracks.length ? `${tracks.length} tracks · ${fmtBytes(totalSize)}` : '';

  if (!tracks.length) {
    host.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('download', 40)}</span>
        <h3>Nothing downloaded yet</h3>
        <p>Hit the download arrow on any track to keep it playable without a connection.</p>
      </div>`;
    return;
  }

  renderTracklist(host, tracks, {
    onRemove: async (t) => {
      await removeDownload(t);
      renderDownloads();
    },
  });
}
