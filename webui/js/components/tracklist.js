// Reusable tracklist renderer.
//
// renderTracklist(host, tracks, opts):
//   opts.onPlay(index)       — row click (default: playTracks(tracks, index))
//   opts.reorderable         — enable drag reorder; opts.onReorder(newIdsOrder)
//   opts.onRemove(track)     — show remove action (context menu entry too)
//   opts.showAlbum           — third column text (default: YouTube channel)
//   opts.emptyHtml           — markup when list is empty
// Returns { refresh(), element }.

import { api, thumbUrl, fmtTime } from '../api.js';
import { get } from '../store.js';
import { icon } from './icons.js';
import { showTrackMenu, downloadTrack, removeDownload, isTrackOffline, decorateButton, updateDownloadButtons } from '../actions.js';

export function renderTracklist(host, tracks, opts = {}) {
  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'tracklist';

  if (!tracks.length) {
    root.innerHTML = opts.emptyHtml || `
      <div class="empty">
        <span class="empty-ico">${icon('music', 42)}</span>
        <h3>Nothing here yet</h3>
        <p>Add tracks from search or radio, or drop in a YouTube link.</p>
      </div>`;
    host.appendChild(root);
    return { refresh: () => renderTracklist(host, tracks, opts), element: root };
  }

  const head = document.createElement('div');
  head.className = 'tl-head';
  head.innerHTML = `
    <span>#</span>
    <span>Title</span>
    <span class="tl-album">${opts.albumHeader || 'Channel'}</span>
    <span style="text-align:right">Time</span>
    <span></span>`;
  root.appendChild(head);

  const onPlay = opts.onPlay || ((index) => {
    import('../player.js').then(p => p.playTracks(tracks, index));
  });

  tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.trackId = t.id;
    row.dataset.index = i + 1;
    row.style.animationDelay = `${Math.min(i * 22, 400)}ms`;
    if (opts.reorderable) { row.draggable = true; row.dataset.pos = i; }

    const cur = get('current');
    const isCur = cur && cur.id === t.id;

    row.innerHTML = `
      <span class="tl-idx">
        ${isCur
          ? `<span class="eqbars ${get('playing') ? '' : 'paused'}"><i></i><i></i><i></i><i></i></span>`
          : `<span class="num">${i + 1}</span><span class="play-ico">${icon('play', 14, true)}</span>`}
      </span>
      <span class="tl-main">
        <img class="tl-cover" loading="lazy" src="${thumbUrl(t)}" alt=""
             onerror="__thumbErr(this)">
        <span class="grow" style="min-width:0">
          <span class="tl-title ellipsis" style="display:block"></span>
          <span class="tl-artist ellipsis" style="display:block"></span>
        </span>
        ${isTrackOffline(t) ? `<span class="offline-dot" title="Available offline"></span>` : ''}
      </span>
      <span class="tl-album ellipsis"></span>
      <span class="tl-dur">${fmtTime(t.duration)}</span>
      <span class="tl-actions">
        <button class="icon-btn sm act-dl" data-dl-track="${t.id}" title="${isTrackOffline(t) ? (t.source === 'local' ? 'Remove from library' : 'Remove download') : 'Download'}"></button>
        <button class="icon-btn sm act-more act-extra" title="More"></button>
      </span>`;
    row.querySelector('.tl-title').textContent = t.title || t.id;
    if (opts.albumAsPlays) {
      row.querySelector('.tl-artist').textContent = t.artist || '';
      row.querySelector('.tl-album').textContent = `${t.play_count || 0}×`;
    } else {
      bindArtistLink(row.querySelector('.tl-artist'), t.artist);
      bindArtistLink(row.querySelector('.tl-album'), t.artist);
    }
    if (isCur) row.classList.add('playing');

    // actions
    const dlBtn = row.querySelector('.act-dl');
    dlBtn.innerHTML = icon(isTrackOffline(t) ? 'download-check' : 'download', 16);
    if (isTrackOffline(t)) dlBtn.classList.add('dl-done');
    decorateButton(dlBtn, t.id);
    updateDownloadButtons(t.id);
    dlBtn.onclick = (e) => {
      e.stopPropagation();
      isTrackOffline(t) ? removeDownload(t, dlBtn) : downloadTrack(t, dlBtn);
      setTimeout(() => {
        const off = isTrackOffline(t);
        dlBtn.innerHTML = icon(off ? 'download-check' : 'download', 16);
        dlBtn.classList.toggle('dl-done', off);
      }, 100);
    };
    const moreBtn = row.querySelector('.act-more');
    moreBtn.innerHTML = icon('more', 16);
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      const r = moreBtn.getBoundingClientRect();
      showTrackMenu(r.right - 210, r.bottom + 6, t, {
        onPlay: () => onPlay(i),
        remove: opts.onRemove ? () => opts.onRemove(t, i) : null,
      });
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showTrackMenu(e.clientX, e.clientY, t, {
        onPlay: () => onPlay(i),
        remove: opts.onRemove ? () => opts.onRemove(t, i) : null,
      });
    };
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      onPlay(i);
    };

    if (opts.reorderable) bindRowDrag(row, root, tracks, opts);
    root.appendChild(row);
  });

  host.appendChild(root);
  return { refresh: () => renderTracklist(host, tracks, opts), element: root };
}

// ── drag reorder ─────────────────────────────────────────────────────

// Artist names open the artist page; album cells under `albumAsPlays`
// show play counts instead and stay inert.
function bindArtistLink(el, artist) {
  if (!el || !artist) { if (el) el.textContent = artist || ''; return; }
  el.textContent = artist;
  el.classList.add('artist-link');
  el.title = `Open ${artist}`;
  el.onclick = (e) => {
    e.stopPropagation();
    location.hash = `#/artist/${encodeURIComponent(artist)}`;
  };
}

let dragEl = null;

function bindRowDrag(row, root, tracks, opts) {
  row.addEventListener('dragstart', (e) => {
    dragEl = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.pos);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    root.querySelectorAll('.tl-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
    dragEl = null;
    if (opts.onReorder) {
      const ids = [...root.querySelectorAll('.tl-row')].map(r => r.dataset.trackId);
      opts.onReorder(ids);
    }
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragEl || dragEl === row) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragEl || dragEl === row) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    root.insertBefore(dragEl, before ? row : row.nextSibling);
    row.classList.remove('drop-before', 'drop-after');
    // renumber
    [...root.querySelectorAll('.tl-row')].forEach((r, i) => {
      r.dataset.pos = i;
      const num = r.querySelector('.tl-idx .num');
      if (num) num.textContent = i + 1;
    });
  });
}

// ── skeleton loader ──────────────────────────────────────────────────

export function skeletonTracklist(host, rows = 8) {
  host.innerHTML = `
    <div class="tracklist">
      ${Array.from({ length: rows }, () => `
        <div class="skel-row">
          <div class="skel skel-cover"></div>
          <div class="grow" style="display:flex;flex-direction:column;gap:7px">
            <div class="skel skel-line" style="width:${38 + Math.random() * 30}%"></div>
            <div class="skel skel-line" style="width:${22 + Math.random() * 18}%;height:8px"></div>
          </div>
          <div class="skel skel-line" style="width:38px"></div>
        </div>`).join('')}
    </div>`;
}

export function skeletonCards(host, n = 6) {
  host.innerHTML = `
    <div class="card-grid">
      ${Array.from({ length: n }, () => `
        <div class="card" style="pointer-events:none">
          <div class="skel skel-card"></div>
          <div class="skel skel-line" style="width:80%;margin-top:10px"></div>
          <div class="skel skel-line" style="width:55%;margin-top:7px;height:8px"></div>
        </div>`).join('')}
    </div>`;
}
