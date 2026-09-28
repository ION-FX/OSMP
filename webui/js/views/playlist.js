// Playlist detail — hero header with cover-mosaic, inline rename, drag reorder,
// play/shuffle, remove tracks, delete playlist.

import { api, thumbUrl, fmtDurLong } from '../api.js';
import { get } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';
import { refreshPlaylists, addToPlaylistDialog, downloadAllTracks, isTrackOffline } from '../actions.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';
import { dominantHues } from '../theme.js';

export async function mount(root, params) {
  const id = params.id;
  root.innerHTML = `<div id="pl-body"></div>`;
  const host = root.querySelector('#pl-body');
  skeletonTracklist(host, 6);

  let pl;
  try {
    pl = await api.playlist(id);
  } catch (e) {
    host.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('alert', 40)}</span>
        <h3>Playlist not found</h3>
        <p>${escapeHtml(String(e.detail || e.message))}</p>
        <a class="btn primary" href="#/library">Back to library</a>
      </div>`;
    return {};
  }

  const tracks = pl.tracks;
  const coverSrc = tracks.length ? thumbUrl(tracks[0]) : null;

  host.innerHTML = `
    <div class="detail-head" id="pl-head">
      ${coverSrc
        ? `<img class="detail-cover" id="pl-cover" src="${coverSrc}" alt="" onerror="__thumbErr(this)">`
        : `<div class="detail-cover" id="pl-cover" style="display:flex;align-items:center;justify-content:center;background:var(--grad);color:#fff">${icon('music', 54)}</div>`}
      <div class="detail-meta grow">
        <div class="detail-kind">Playlist${pl.kind === 'radio' ? ' · radio' : ''}</div>
        <h1 id="pl-name"></h1>
        <div class="detail-sub">
          <span id="pl-desc"></span>
          <span>·</span>
          <span>${tracks.length} tracks</span>
          <span>·</span>
          <span>${fmtDurLong(pl.total_duration)}</span>
        </div>
        <div class="detail-actions">
          <button class="play-big" id="pl-play" title="Play">${icon('play', 22, true)}</button>
          <button class="btn ghost" id="pl-shuffle">${icon('shuffle', 15)} Shuffle</button>
          <button class="btn ghost" id="pl-add">${icon('plus', 15)} Add tracks</button>
          <button class="btn ghost" id="pl-dlall" title="Download every track to the server library">${icon('download', 15)} Download all</button>
          <button class="icon-btn" id="pl-rename" title="Rename">${icon('edit', 17)}</button>
          <button class="icon-btn" id="pl-delete" title="Delete playlist">${icon('trash', 17)}</button>
        </div>
      </div>
    </div>
    <div class="section-head-row" id="pl-tools" style="margin:18px 0 4px">
      <div class="chip-row" id="pl-sort"></div>
    </div>
    <div id="pl-list"></div>`;

  host.querySelector('#pl-name').textContent = pl.name;
  host.querySelector('#pl-desc').textContent = pl.description || '';
  if (!pl.description) host.querySelector('#pl-desc').style.display = 'none';

  // tint the header from the first cover
  if (coverSrc) {
    dominantHues(coverSrc).then(hues => {
      if (hues) host.querySelector('#pl-head').style.setProperty('--ph', hues.h1);
    });
  }

  // display-only sorting — drag reorder applies in "Playlist order" mode
  const SORTS = [
    { id: 'playlist', label: 'Playlist order' },
    { id: 'title', label: 'Title' },
    { id: 'artist', label: 'Artist' },
    { id: 'added', label: 'Recently added' },
    { id: 'duration', label: 'Longest' },
  ];
  let sortOrder = 'playlist';
  const sortHost = host.querySelector('#pl-sort');
  if (tracks.length > 1) {
    SORTS.forEach(sv => {
      const c = document.createElement('button');
      c.className = `chip${sv.id === sortOrder ? ' on' : ''}`;
      c.textContent = sv.label;
      c.onclick = () => {
        sortOrder = sv.id;
        sortHost.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        renderList();
      };
      sortHost.appendChild(c);
    });
  } else {
    host.querySelector('#pl-tools').style.display = 'none';
  }
  const displayTracks = () => {
    const t = [...tracks];
    if (sortOrder === 'title') {
      t.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (sortOrder === 'artist') {
      t.sort((a, b) => (a.artist || '').localeCompare(b.artist || '')
        || (a.title || '').localeCompare(b.title || ''));
    } else if (sortOrder === 'added') {
      t.reverse();  // position order = add order
    } else if (sortOrder === 'duration') {
      t.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    }
    return t;
  };

  const listHost = host.querySelector('#pl-list');
  if (!tracks.length) {
    listHost.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('music', 40)}</span>
        <h3>Empty playlist</h3>
        <p>Search for tracks and use “Add to playlist”, or generate a radio mix and save it here.</p>
        <div class="row gap-m">
          <a class="btn primary" href="#/search">${icon('search', 15)} Find music</a>
          <a class="btn ghost" href="#/radio">${icon('radio', 15)} Radio</a>
        </div>
      </div>`;
  } else {
    renderList();
  }

  function renderList() {
    renderTracklist(listHost, displayTracks(), {
      reorderable: sortOrder === 'playlist',
      onReorder: async (ids) => {
        try {
          await api.reorderPlaylist(id, ids);
          // reorder local copy to match
          tracks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          toastOk('Order saved');
        } catch (e) {
          toastErr('Reorder failed');
          renderList();
        }
      },
      onRemove: async (t) => {
        try {
          await api.removeFromPlaylist(id, t.id);
          tracks.splice(tracks.indexOf(t), 1);
          renderList();
          refreshPlaylists();
          toast(`Removed “${t.title}”`, { icon: 'trash' });
        } catch (e) { toastErr('Remove failed'); }
      },
    });
  }

  host.querySelector('#pl-play').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0));
  };
  host.querySelector('#pl-shuffle').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0, { shuffle: true, random: true }));
  };
  host.querySelector('#pl-add').onclick = () => {
    location.hash = '#/search';
    toast('Search for tracks, then ⋮ → Add to playlist', { icon: 'search', timeout: 5200 });
  };
  const dlAllBtn = host.querySelector('#pl-dlall');
  dlAllBtn.onclick = async () => {
    const pending = tracks.filter(t => !isTrackOffline(t));
    if (pending.length > 12) {
      const ok = await confirmDialog({
        title: `Download ${pending.length} tracks?`,
        message: 'They download to the server one at a time — you can keep using OSMP meanwhile.',
        confirmLabel: 'Download',
      });
      if (!ok) return;
    }
    dlAllBtn.disabled = true;
    const paint = () => {
      dlAllBtn.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 15)}</span> ${dlAllBtn.dataset.n || ''}`;
    };
    dlAllBtn.dataset.n = 'Downloading…';
    paint();
    await downloadAllTracks(tracks, {
      onProgress: (i, n) => { dlAllBtn.dataset.n = `${i}/${n}`; paint(); },
    });
    dlAllBtn.disabled = false;
    delete dlAllBtn.dataset.n;
    dlAllBtn.innerHTML = `${icon('download', 15)} Download all`;
  };
  host.querySelector('#pl-rename').onclick = async () => {
    const name = await promptDialog({ title: 'Rename playlist', value: pl.name, placeholder: 'New name', confirmLabel: 'Rename' });
    if (!name) return;
    try {
      await api.renamePlaylist(id, name);
      host.querySelector('#pl-name').textContent = name;
      refreshPlaylists();
      toastOk('Renamed');
    } catch (e) { toastErr('Rename failed'); }
  };
  host.querySelector('#pl-delete').onclick = async () => {
    const ok = await confirmDialog({
      title: `Delete “${pl.name}”?`,
      message: `${tracks.length} tracks will be removed from this playlist. Downloads stay in your library.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePlaylist(id);
      await refreshPlaylists();
      toastOk('Playlist deleted');
      location.hash = '#/library';
    } catch (e) { toastErr('Delete failed'); }
  };

  return {};
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
