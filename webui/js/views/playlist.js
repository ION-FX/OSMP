// Playlist detail — hero header with cover-mosaic, inline rename, drag reorder,
// play/shuffle, remove tracks, delete playlist.

import { api, thumbUrl, fmtDurLong } from '../api.js';
import { get } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';
import { refreshPlaylists, addToPlaylistDialog, downloadAllTracks, isTrackOffline } from '../actions.js';
import { confirmDialog, promptDialog, customDialog } from '../components/dialog.js';
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
  const isOwner = !!pl.is_mine;
  const canEdit = !!pl.can_edit;

  host.innerHTML = `
    <div class="detail-head" id="pl-head">
      ${coverSrc
        ? `<img class="detail-cover" id="pl-cover" src="${escapeHtml(coverSrc)}" alt="" onerror="__thumbErr(this)">`
        : `<div class="detail-cover" id="pl-cover" style="display:flex;align-items:center;justify-content:center;background:var(--grad);color:#fff">${icon('music', 54)}</div>`}
      <div class="detail-meta grow">
        <div class="detail-kind" id="pl-kind"></div>
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
          ${canEdit ? `<button class="btn ghost" id="pl-add">${icon('plus', 15)} Add tracks</button>` : ''}
          <button class="btn ghost" id="pl-dlall" title="Download every track to the server library">${icon('download', 15)} Download all</button>
          ${isOwner ? `
            <button class="btn ghost" id="pl-share" title="Share with other accounts">${icon('user', 15)} Share</button>
            <button class="icon-btn" id="pl-rename" title="Rename">${icon('edit', 17)}</button>
            <button class="icon-btn" id="pl-delete" title="Delete playlist">${icon('trash', 17)}</button>` : ''}
        </div>
      </div>
    </div>
    <div class="section-head-row" id="pl-tools" style="margin:18px 0 4px">
      <div class="chip-row" id="pl-sort"></div>
    </div>
    <div id="pl-list"></div>`;

  host.querySelector('#pl-kind').innerHTML =
    `Playlist${pl.kind === 'radio' ? ' · radio' : ''}${isOwner ? '' : ` · by <b></b>${canEdit ? ' · you can edit' : ' · view only'}`}`;
  if (!isOwner) host.querySelector('#pl-kind b').textContent = pl.owner || 'someone';
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
      reorderable: canEdit && sortOrder === 'playlist',
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
      onRemove: canEdit ? async (t) => {
        try {
          await api.removeFromPlaylist(id, t.id);
          tracks.splice(tracks.indexOf(t), 1);
          renderList();
          refreshPlaylists();
          toast(`Removed “${t.title}”`, { icon: 'trash' });
        } catch (e) { toastErr('Remove failed'); }
      } : null,
    });
  }

  host.querySelector('#pl-play').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0));
  };
  host.querySelector('#pl-shuffle').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0, { shuffle: true, random: true }));
  };
  host.querySelector('#pl-add')?.addEventListener('click', () => {
    location.hash = '#/search';
    toast('Search for tracks, then ⋮ → Add to playlist', { icon: 'search', timeout: 5200 });
  });
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
  host.querySelector('#pl-rename')?.addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Rename playlist', value: pl.name, placeholder: 'New name', confirmLabel: 'Rename' });
    if (!name) return;
    try {
      await api.renamePlaylist(id, name);
      host.querySelector('#pl-name').textContent = name;
      refreshPlaylists();
      toastOk('Renamed');
    } catch (e) { toastErr('Rename failed'); }
  });
  host.querySelector('#pl-share')?.addEventListener('click', () => openShareDialog(pl, host));
  host.querySelector('#pl-delete')?.addEventListener('click', async () => {
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
  });

  return {};
}

// Owner-only share editor: pick accounts, grant view or edit, save the set.
async function openShareDialog(pl, host) {
  let users = [];
  try { users = (await api.usersBrief()).users; } catch { /* offline */ }
  const shares = (pl.shares || []).map(s => ({ ...s }));
  const eligible = () => users.filter(u =>
    u.username !== pl.owner && !shares.some(s => s.username === u.username));

  customDialog({
    title: `Share “${pl.name}”`,
    bodyHtml: `
      <p class="dim" style="font-size:12.5px;margin-bottom:10px">
        Friends see this playlist in their sidebar. <b>Can edit</b> lets them add,
        remove and reorder tracks — renaming and deleting stay yours.</p>
      <div id="sh-rows"></div>
      <div class="row gap-s" style="margin-top:14px;align-items:center;flex-wrap:wrap">
        <select id="sh-user" class="input" style="width:auto;min-width:160px"></select>
        <label class="row gap-s" style="font-size:13px;cursor:pointer">
          <input type="checkbox" id="sh-edit"> can edit
        </label>
        <button class="btn ghost" id="sh-add">${icon('plus', 14)} Add</button>
      </div>`,
    actionsHtml: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Save</button>`,
  }, (root, close) => {
    const rows = root.querySelector('#sh-rows');
    const userSel = root.querySelector('#sh-user');
    const editBox = root.querySelector('#sh-edit');

    const paintRows = () => {
      rows.innerHTML = '';
      if (!shares.length) {
        const hint = document.createElement('div');
        hint.className = 'faint';
        hint.style.cssText = 'font-size:13px;padding:4px 0';
        hint.textContent = 'Not shared with anyone yet.';
        rows.appendChild(hint);
      }
      shares.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'row gap-s';
        row.style.cssText = 'align-items:center;padding:5px 0';
        row.innerHTML = `<span class="grow ellipsis"></span>
          <label class="row gap-s" style="font-size:13px;cursor:pointer">
            <input type="checkbox"${s.can_edit ? ' checked' : ''}> can edit
          </label>
          <button class="icon-btn sm" title="Stop sharing"></button>`;
        row.querySelector('.ellipsis').textContent = s.username;
        row.querySelector('input').onchange = (e) => { s.can_edit = e.target.checked; };
        row.querySelector('button').innerHTML = icon('close', 14);
        row.querySelector('button').onclick = () => { shares.splice(i, 1); paintRows(); paintSelect(); };
        rows.appendChild(row);
      });
    };
    const paintSelect = () => {
      userSel.innerHTML = '';
      const pool = eligible();
      if (!pool.length) {
        const o = document.createElement('option');
        o.textContent = users.length ? 'everyone already added' : 'no other accounts';
        userSel.appendChild(o);
        userSel.disabled = true;
        root.querySelector('#sh-add').disabled = true;
      } else {
        userSel.disabled = false;
        root.querySelector('#sh-add').disabled = false;
        pool.forEach(u => {
          const o = document.createElement('option');
          o.value = u.username;
          o.textContent = u.username;
          userSel.appendChild(o);
        });
      }
    };
    root.querySelector('#sh-add').onclick = () => {
      const name = userSel.value;
      if (!name || !eligible().some(u => u.username === name)) return;
      shares.push({ username: name, can_edit: editBox.checked });
      editBox.checked = false;
      paintRows(); paintSelect();
    };
    paintRows(); paintSelect();

    root.querySelector('[data-act="cancel"]').onclick = () => close(null);
    root.querySelector('[data-act="save"]').onclick = async () => {
      try {
        const res = await api.sharePlaylist(pl.id, shares);
        pl.shares = res.shares || [];
        close(true);
        toastOk(pl.shares.length
          ? `Shared with ${pl.shares.length} account${pl.shares.length === 1 ? '' : 's'}`
          : 'Sharing removed', { icon: 'user' });
      } catch (e) { toastErr(e.detail || 'Share failed'); }
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
