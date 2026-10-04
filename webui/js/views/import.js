// Import — paste a YouTube playlist / album / channel link, preview the
// tracks, untick what you don't want, and turn it into a real OSMP playlist.

import { api, isImportLink, thumbUrl, fmtDurLong, fmtTime } from '../api.js';
import { rememberTracks } from '../store.js';
import { icon } from '../components/icons.js';
import { toastOk, toastErr } from '../components/toast.js';
import { refreshPlaylists } from '../actions.js';
import { skeletonTracklist } from '../components/tracklist.js';
import { dominantHues } from '../theme.js';

let renderToken = 0;

export async function mount(root, params) {
  root.innerHTML = `
    <div class="view-head" style="flex-direction:column;align-items:stretch;gap:14px">
      <h1>Import from YouTube</h1>
      <div style="position:relative;max-width:680px">
        <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-faint);display:flex" id="imp-ico"></span>
        <input id="imp-url" class="input" type="url" autocomplete="off" spellcheck="false"
               placeholder="Playlist, album or channel link — youtube.com/playlist?list=…"
               style="padding-left:44px;padding-right:120px;height:50px;border-radius:26px">
        <button id="imp-go-url" class="btn primary"
                style="position:absolute;right:7px;top:50%;transform:translateY(-50%);height:36px;border-radius:19px;padding:0 16px">
          Preview
        </button>
      </div>
    </div>
    <div id="imp-body"></div>`;

  const input = root.querySelector('#imp-url');
  const body = root.querySelector('#imp-body');
  root.querySelector('#imp-ico').innerHTML = icon('download', 18);
  root.querySelector('#imp-go-url').onclick = () => preview(input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); preview(input.value); }
  });

  function emptyState() {
    body.innerHTML = `
      <div class="empty" style="margin-top:30px">
        <span class="empty-ico">${icon('playlist-plus', 42)}</span>
        <h3>Bring your music over</h3>
        <p>Paste any public YouTube playlist, album or channel link above — preview it,
           untick anything you don't want, and it becomes an OSMP playlist.<br>
          <span class="faint">Works with youtube.com/playlist, music.youtube.com albums,
          @channel uploads and bare playlist IDs.</span></p>
      </div>`;
  }

  async function preview(url) {
    url = (url || '').trim();
    const my = ++renderToken;
    if (!url) { emptyState(); return; }
    if (!isImportLink(url)) {
      body.innerHTML = `
        <div class="empty" style="margin-top:30px">
          <span class="empty-ico">${icon('alert', 40)}</span>
          <h3>That's not an importable link</h3>
          <p>I need a YouTube <b>playlist</b>, <b>album</b> or <b>channel</b> link —
             single videos go through Search instead.</p>
        </div>`;
      return;
    }
    body.innerHTML = `
      <div class="section-head-row" style="margin-top:8px"><h2>Reading the source…</h2></div>`;
    skeletonTracklist(body, 7);
    try {
      const pl = await api.importPreview(url);
      if (my !== renderToken) return;
      renderPreview(pl);
    } catch (e) {
      if (my !== renderToken) return;
      renderError(e);
    }
  }

  function renderError(e) {
    const msg = String(e.detail || e.message || 'Import failed');
    const mix = /endless|mix/i.test(msg);
    body.innerHTML = `
      <div class="empty" style="margin-top:30px">
        <span class="empty-ico">${icon('alert', 40)}</span>
        <h3>Couldn't load that source</h3>
        <p>${escapeHtml(msg)}</p>
        <div class="row gap-m" style="justify-content:center;margin-top:16px">
          ${mix ? `<a class="btn ghost" href="#/radio">${icon('radio', 15)} Use Radio for mixes</a>` : ''}
          <a class="btn primary" href="#/search">${icon('search', 15)} Back to search</a>
        </div>
      </div>`;
  }

  function renderPreview(pl) {
    rememberTracks(pl.items);
    const cover = pl.thumbnail || (pl.items[0] && thumbUrl(pl.items[0]));
    const kind = pl.kind === 'channel' ? 'Channel' : pl.kind === 'album' ? 'Album' : 'Playlist';

    body.innerHTML = `
      <div class="detail-head" id="imp-head">
        ${cover
          ? `<img class="detail-cover" src="${escapeHtml(cover)}" alt="" onerror="__thumbErr(this)">`
          : `<div class="detail-cover" style="display:flex;align-items:center;justify-content:center;background:var(--grad);color:#fff">${icon('music', 54)}</div>`}
        <div class="detail-meta grow">
          <div class="detail-kind">${kind} · YouTube import</div>
          <h1 id="imp-title"></h1>
          <div class="detail-sub">
            ${pl.uploader ? `<span id="imp-by"></span><span>·</span>` : ''}
            <span>${pl.items.length} tracks</span>
            <span>·</span>
            <span>${fmtDurLong(pl.total_duration)}</span>
            ${pl.truncated ? `<span class="nav-badge beta" title="Big sources are capped at the first 500 uploads">first 500</span>` : ''}
          </div>
          <div class="detail-actions" style="flex-wrap:wrap;gap:10px">
            <input id="imp-name" class="input" style="height:44px;max-width:300px" maxlength="120" spellcheck="false">
            <button class="btn ghost" id="imp-all">${icon('check', 15)} All</button>
            <button class="btn ghost" id="imp-none">None</button>
          </div>
        </div>
      </div>
      <div class="imp-list">
        <div class="tl-head"><span></span><span>Title</span><span style="text-align:right">Time</span></div>
        <div id="imp-rows"></div>
      </div>
      <div class="imp-foot">
        <span id="imp-count" class="dim" style="font-size:13.5px"></span>
        <span class="spacer"></span>
        <button class="btn ghost" id="imp-restart">Start over</button>
        <button class="btn primary lg" id="imp-do"></button>
      </div>`;

    body.querySelector('#imp-title').textContent = pl.title;
    if (pl.uploader) body.querySelector('#imp-by').textContent = pl.uploader;
    body.querySelector('#imp-name').value = pl.title;

    if (cover) {
      dominantHues(String(cover).replace('hqdefault', 'maxresdefault')).then(hues => {
        if (hues) body.querySelector('#imp-head')?.style.setProperty('--ph', hues.h1);
      });
    }

    const rowsHost = body.querySelector('#imp-rows');
    const frag = document.createDocumentFragment();
    pl.items.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'tl-row imp-row';
      row.dataset.id = t.id;
      row.style.animationDelay = `${Math.min(i * 14, 300)}ms`;
      row.innerHTML = `
        <span class="tl-idx"><input type="checkbox" class="imp-check" checked aria-label="Import this track"></span>
        <span class="tl-main">
          <img class="tl-cover" loading="lazy" src="${escapeHtml(thumbUrl(t, 'hq'))}" alt="" onerror="__thumbErr(this)">
          <span class="grow" style="min-width:0">
            <span class="tl-title ellipsis" style="display:block"></span>
            <span class="tl-artist ellipsis" style="display:block"></span>
          </span>
        </span>
        <span class="tl-dur">${fmtTime(t.duration)}</span>`;
      row.querySelector('.tl-title').textContent = t.title || t.id;
      row.querySelector('.tl-artist').textContent = t.artist || '';
      frag.appendChild(row);
    });
    rowsHost.appendChild(frag);

    const countEl = body.querySelector('#imp-count');
    const doBtn = body.querySelector('#imp-do');
    const selected = () => [...rowsHost.querySelectorAll('.imp-row')]
      .filter(r => r.querySelector('.imp-check').checked);
    const refreshCount = () => {
      const n = selected().length;
      countEl.textContent = `${n} of ${pl.items.length} tracks selected`;
      doBtn.textContent = `Import ${n} track${n === 1 ? '' : 's'}`;
      doBtn.disabled = n === 0;
    };
    rowsHost.addEventListener('change', (e) => {
      if (!e.target.classList.contains('imp-check')) return;
      e.target.closest('.imp-row').classList.toggle('unchecked', !e.target.checked);
      refreshCount();
    });
    rowsHost.addEventListener('click', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const row = e.target.closest('.imp-row');
      if (!row) return;
      const cb = row.querySelector('.imp-check');
      cb.checked = !cb.checked;
      row.classList.toggle('unchecked', !cb.checked);
      refreshCount();
    });
    body.querySelector('#imp-all').onclick = () => {
      rowsHost.querySelectorAll('.imp-check').forEach(cb => { cb.checked = true; });
      rowsHost.querySelectorAll('.imp-row').forEach(r => r.classList.remove('unchecked'));
      refreshCount();
    };
    body.querySelector('#imp-none').onclick = () => {
      rowsHost.querySelectorAll('.imp-check').forEach(cb => { cb.checked = false; });
      rowsHost.querySelectorAll('.imp-row').forEach(r => r.classList.add('unchecked'));
      refreshCount();
    };
    body.querySelector('#imp-restart').onclick = () => {
      renderToken++;
      input.value = '';
      emptyState();
      input.focus();
    };
    refreshCount();

    doBtn.onclick = async () => {
      const ids = selected().map(r => r.dataset.id);
      if (!ids.length) return;
      doBtn.disabled = true;
      doBtn.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 16)}</span> Importing…`;
      const name = body.querySelector('#imp-name').value.trim() || pl.title;
      try {
        const res = await api.importApply(pl.preview_id, name, ids);
        await refreshPlaylists();
        toastOk(`Imported ${res.added} tracks into “${name}”`);
        location.hash = `#/playlist/${res.playlist_id}`;
      } catch (e) {
        toastErr(e.detail || 'Import failed');
        doBtn.disabled = false;
        doBtn.textContent = `Import ${ids.length} tracks`;
      }
    };
  }

  if (params.url) {
    input.value = params.url;
    preview(params.url);
  } else {
    emptyState();
    setTimeout(() => input.focus(), 120);
  }

  return { unmount };  // router hook — cancels in-flight previews on navigation
}

export function unmount() {
  renderToken++;  // drop any in-flight preview render
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
