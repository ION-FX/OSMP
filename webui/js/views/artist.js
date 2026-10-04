// Artist page — hero with library stats, every track you have by that
// artist (most played first), and one-click radio / download-all.

import { api, thumbUrl, fmtDurLong } from '../api.js';
import { get } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';
import { downloadAllTracks } from '../actions.js';

function artistHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export async function mount(root, params) {
  const name = (params.name || '').trim();
  root.innerHTML = `<div id="ar-body"></div>`;
  const host = root.querySelector('#ar-body');
  skeletonTracklist(host, 6);

  let data;
  try {
    data = await api.artist(name);
  } catch (e) {
    host.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('alert', 40)}</span>
        <h3>Couldn't load that artist</h3>
        <p>${escapeHtml(String(e.detail || e.message))}</p>
        <a class="btn ghost" href="#/library">Back to library</a>
      </div>`;
    return {};
  }

  const hue = artistHue(data.artist || '?');
  const tracks = data.tracks;
  const coverSrc = tracks.length ? thumbUrl(tracks[0]) : null;
  const lastPlayed = data.last_played
    ? new Date(data.last_played * 1000).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric' })
    : null;

  host.innerHTML = `
    <div class="detail-head" id="ar-head" style="--ph:${hue}">
      ${coverSrc
        ? `<img class="detail-cover round" src="${escapeHtml(coverSrc)}" alt="" onerror="__thumbErr(this)">`
        : `<div class="detail-cover round" style="display:flex;align-items:center;justify-content:center;
             background:linear-gradient(135deg, hsl(${hue} 60% 34%), hsl(${(hue + 70) % 360} 70% 50%));color:#fff">
             ${escapeHtml((data.artist || '?').slice(0, 1).toUpperCase())}</div>`}
      <div class="detail-meta grow">
        <div class="detail-kind">Artist</div>
        <h1 id="ar-name"></h1>
        <div class="detail-sub">
          <span>${tracks.length} track${tracks.length === 1 ? '' : 's'} in your library</span>
          ${tracks.length ? `<span>·</span><span>${fmtDurLong(data.total_duration)}</span>` : ''}
          ${data.plays ? `<span>·</span><span>${data.plays} play${data.plays === 1 ? '' : 's'}</span>` : ''}
          ${lastPlayed ? `<span>·</span><span>last played ${lastPlayed}</span>` : ''}
        </div>
        <div class="detail-actions">
          <button class="play-big" id="ar-play" title="Play">${icon('play', 22, true)}</button>
          <button class="btn ghost" id="ar-shuffle">${icon('shuffle', 15)} Shuffle</button>
          <button class="btn ghost" id="ar-radio">${icon('radio', 15)} Radio</button>
          <button class="btn ghost" id="ar-dlall">${icon('download', 15)} Download all</button>
        </div>
      </div>
    </div>
    <div id="ar-list"></div>`;

  host.querySelector('#ar-name').textContent = data.artist;

  const listHost = host.querySelector('#ar-list');
  if (!tracks.length) {
    listHost.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('music', 40)}</span>
        <h3>Nothing by ${escapeHtml(data.artist)} in your library yet</h3>
        <p>Radio can build a mix from YouTube's recommendation graph in one click.</p>
        <button class="btn primary" id="ar-radio2">${icon('radio', 15)} Start ${escapeHtml(data.artist)} radio</button>
      </div>`;
    listHost.querySelector('#ar-radio2').onclick = () => {
      location.hash = `#/radio?seed=${encodeURIComponent(data.artist)}&auto=1`;
    };
  } else {
    renderTracklist(listHost, tracks, { albumHeader: 'Plays', albumAsPlays: true });
  }

  host.querySelector('#ar-play').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0));
  };
  host.querySelector('#ar-shuffle').onclick = () => {
    if (tracks.length) import('../player.js').then(p =>
      p.playTracks(tracks, 0, { shuffle: true, random: true }));
  };
  host.querySelector('#ar-radio').onclick = () => {
    location.hash = `#/radio?seed=${encodeURIComponent(data.artist)}&auto=1`;
  };
  const dlAll = host.querySelector('#ar-dlall');
  dlAll.onclick = async () => {
    if (!tracks.length) { toast('No tracks to download'); return; }
    dlAll.disabled = true;
    dlAll.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 15)}</span> Downloading…`;
    try {
      await downloadAllTracks(tracks);
    } catch (e) {
      toastErr('Download failed');
    }
    dlAll.disabled = false;
    dlAll.innerHTML = `${icon('download', 15)} Download all`;
  };

  return {};
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
