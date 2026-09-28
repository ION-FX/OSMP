// History — the full play journal for this account, grouped by day.
// Unlike "Jump back in" (deduped, 12 rows), this is every play in order.

import { api, thumbUrl, fmtTime } from '../api.js';
import { icon } from '../components/icons.js';
import { rememberTracks } from '../store.js';

const PAGE = 120;

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, new Date())) return 'Today';
  if (same(d, new Date(Date.now() - 86400000))) return 'Yesterday';
  return d.toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });
}

function timeLabel(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined,
    { hour: '2-digit', minute: '2-digit' });
}

export async function mount(root) {
  root.innerHTML = `
    <div class="view-head">
      <h1>${icon('clock', 24)} &nbsp;History</h1>
      <span class="faint" style="font-size:12.5px">every play, newest first</span>
    </div>
    <div id="hy-body"><div class="stats-skel">
      ${Array.from({ length: 6 }, () => '<div class="skel skel-line"></div>').join('')}
    </div></div>
    <div class="row" style="justify-content:center;margin:22px 0">
      <button class="btn ghost hidden" id="hy-more">Load more</button>
    </div>`;

  const body = root.querySelector('#hy-body');
  const moreBtn = root.querySelector('#hy-more');
  let fetched = PAGE;  // how many rows we've asked the server for

  const render = (plays) => {
    const stick = window.scrollY;
    body.innerHTML = '';
    let currentDay = null;
    let list = null;
    plays.forEach((p) => {
      const day = dayLabel(p.played_at);
      if (day !== currentDay) {
        currentDay = day;
        const sec = document.createElement('section');
        sec.className = 'section';
        sec.innerHTML = `
          <div class="section-head-row">
            <h2>${escapeHtml(day)}</h2>
            <span class="faint hy-daycount" style="font-size:12px"></span>
          </div>
          <div class="card" style="padding:6px 10px"></div>`;
        list = sec.querySelector('.card');
        sec.querySelector('.hy-daycount').dataset.count = '0';
        body.appendChild(sec);
      }
      const row = document.createElement('button');
      row.className = 'rank-row track';
      row.innerHTML = `
        <span class="rank-num">${timeLabel(p.played_at)}</span>
        <img class="rank-cover" src="${thumbUrl(p, 'mq')}" alt="" loading="lazy" onerror="__thumbErr(this)">
        <span class="grow" style="min-width:0;text-align:left">
          <span class="rank-name ellipsis" style="display:block"></span>
          <span class="rank-sub ellipsis" style="display:block"></span>
        </span>
        <span class="rank-meta">${fmtTime(p.duration || 0)}</span>
        <span class="rank-ico">${icon('play', 15, true)}</span>`;
      row.querySelector('.rank-name').textContent = p.title || p.id;
      row.querySelector('.rank-sub').textContent = p.artist || '';
      row.onclick = () => {
        rememberTracks([p]);
        import('../player.js').then(pl => pl.playTracks([p], 0));
      };
      list.appendChild(row);
      const counter = body.lastElementChild.querySelector('.hy-daycount');
      counter.dataset.count = String(+counter.dataset.count + 1);
    });
    // day counts (a day can span the whole list)
    body.querySelectorAll('.section').forEach(sec => {
      const n = sec.querySelectorAll('.rank-row').length;
      sec.querySelector('.hy-daycount').textContent =
        `${n} play${n === 1 ? '' : 's'}`;
    });
    window.scrollTo(0, stick);
  };

  const load = async () => {
    try {
      const data = await api.historyLog(fetched);
      const plays = data.plays;
      if (!plays.length) {
        body.innerHTML = `
          <div class="empty">
            <span class="empty-ico">${icon('clock', 40)}</span>
            <h3>No plays yet</h3>
            <p>Everything you listen to shows up here, newest first.</p>
            <a class="btn primary" href="#/search">Find something</a>
          </div>`;
        moreBtn.classList.add('hidden');
        return;
      }
      render(plays);
      moreBtn.classList.toggle('hidden', plays.length < fetched);
    } catch (e) {
      body.innerHTML = `
        <div class="empty">
          <span class="empty-ico">${icon('alert', 40)}</span>
          <h3>Couldn't load history</h3>
          <p>${escapeHtml(String(e.detail || e.message))}</p>
        </div>`;
    }
  };

  moreBtn.onclick = async () => {
    fetched += PAGE;
    moreBtn.disabled = true;
    await load();
    moreBtn.disabled = false;
  };
  await load();
  return {};
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
