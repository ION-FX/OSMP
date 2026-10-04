// Smart playlists — rule-based lists evaluated server-side, so they update
// themselves. One view module covers three states:
//   #/smart/new          editor seeded with a blank (or preset) spec
//   #/smart/{id}         detail: live track list, play/shuffle/download
//   #/smart/{id}/edit    the same editor, saving patches the definition

import { api, fmtDurLong } from '../api.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { renderTracklist, skeletonTracklist } from '../components/tracklist.js';
import { downloadAllTracks, isTrackOffline } from '../actions.js';
import { confirmDialog } from '../components/dialog.js';

const FIELDS = {
  plays:       { label: 'Play count',  kind: 'int' },
  last_played: { label: 'Last played', kind: 'days' },
  added:       { label: 'Date added',  kind: 'days' },
  duration:    { label: 'Length',      kind: 'seconds' },
  artist:      { label: 'Artist',      kind: 'text' },
  title:       { label: 'Title',       kind: 'text' },
  source:      { label: 'Source',      kind: 'enum' },
  offline:     { label: 'Downloaded',  kind: 'bool' },
};
const OPS = {
  int:     [['gte', 'at least'], ['lte', 'at most'], ['eq', 'exactly']],
  days:    [['within', 'in the last'], ['before', 'older than'], ['never', 'never']],
  seconds: [['lte', 'shorter than'], ['gte', 'longer than']],
  text:    [['contains', 'contains'], ['is', 'is exactly']],
  enum:    [['is', 'is']],
  bool:    [['is', 'is']],
};
const SOURCES = [['youtube', 'from YouTube'], ['local', 'uploaded by me']];
// cover icons — SVG, so they render on systems without an emoji font
const COVER_ICONS = ['sparkles', 'zap', 'star', 'heart', 'repeat', 'moon',
  'sun', 'waves', 'disc', 'music', 'clock', 'radio'];
const ORDERS = [
  ['most_played', 'Most played'],
  ['recently_played', 'Recently played'],
  ['recently_added', 'Recently added'],
  ['random', 'Random'],
  ['title', 'Title A–Z'],
  ['artist', 'Artist A–Z'],
];

// Renders a smart-playlist cover value: "icon:name" → SVG, anything else is
// treated as (optional) emoji text.
export function smartCoverArt(emoji, size = 36) {
  if (emoji && emoji.startsWith('icon:')) {
    return `<span style="color:#fff;display:flex;align-items:center;justify-content:center">${icon(emoji.slice(5), size, true)}</span>`;
  }
  const ch = escapeHtml(emoji || '✨');
  return `<span style="font-size:${size}px;line-height:1">${ch}</span>`;
}

export async function mount(root, params) {
  if (!params.id) return mountEditor(root, null, {});
  if (params.edit) {
    let row;
    try { row = await api.smart(params.id); } catch { location.hash = '#/library'; return {}; }
    return mountEditor(root, row, row.spec);
  }
  return mountDetail(root, params.id);
}

// ────────────────────────────────────────────── detail

async function mountDetail(root, id) {
  root.innerHTML = `<div id="sm-body"></div>`;
  const host = root.querySelector('#sm-body');
  skeletonTracklist(host, 6);

  let sp;
  try {
    sp = await api.smart(id);
  } catch (e) {
    host.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('alert', 40)}</span>
        <h3>Smart playlist not found</h3>
        <a class="btn primary" href="#/library">Back to library</a>
      </div>`;
    return {};
  }
  const tracks = sp.tracks || [];

  host.innerHTML = `
    <div class="detail-head" id="sm-head">
      <div class="detail-cover" style="display:flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg, hsl(${(sp.id * 61 + 130) % 360} 55% 32%), hsl(${(sp.id * 61 + 210) % 360} 65% 48%))">
        ${smartCoverArt(sp.emoji, 52)}</div>
      <div class="detail-meta grow">
        <div class="detail-kind">Smart playlist · updates itself</div>
        <h1 id="sm-name"></h1>
        <div class="detail-sub">
          <span id="sm-summary"></span>
          <span>·</span>
          <span>${sp.track_count} track${sp.track_count === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>${fmtDurLong(sp.total_duration)}</span>
        </div>
        <div class="detail-actions">
          <button class="play-big" id="sm-play" title="Play">${icon('play', 22, true)}</button>
          <button class="btn ghost" id="sm-shuffle">${icon('shuffle', 15)} Shuffle</button>
          <button class="btn ghost" id="sm-dlall" title="Download every track to the server library">${icon('download', 15)} Download all</button>
          <button class="btn ghost" id="sm-edit">${icon('edit', 15)} Edit rules</button>
          <button class="icon-btn" id="sm-delete" title="Delete">${icon('trash', 17)}</button>
        </div>
      </div>
    </div>
    <div id="sm-list" style="margin-top:18px"></div>`;
  host.querySelector('#sm-name').textContent = sp.name;
  host.querySelector('#sm-summary').textContent = sp.summary || '';

  const listHost = host.querySelector('#sm-list');
  if (!tracks.length) {
    listHost.innerHTML = `
      <div class="empty">
        <span class="empty-ico">${icon('music', 40)}</span>
        <h3>Nothing matches yet</h3>
        <p>As your library grows (plays, downloads, uploads), this list fills itself.</p>
        <a class="btn ghost" href="#/smart/${id}/edit">${icon('edit', 15)} Loosen the rules</a>
      </div>`;
  } else {
    renderTracklist(listHost, tracks, {});
  }

  host.querySelector('#sm-play').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0));
  };
  host.querySelector('#sm-shuffle').onclick = () => {
    if (tracks.length) import('../player.js').then(p => p.playTracks(tracks, 0, { shuffle: true, random: true }));
  };
  const dlBtn = host.querySelector('#sm-dlall');
  dlBtn.onclick = async () => {
    const pending = tracks.filter(t => !isTrackOffline(t));
    if (!pending.length) { toast('Everything here is already downloaded', { icon: 'info' }); return; }
    if (pending.length > 12) {
      const ok = await confirmDialog({
        title: `Download ${pending.length} tracks?`,
        message: 'They download to the server one at a time — you can keep using OSMP meanwhile.',
        confirmLabel: 'Download',
      });
      if (!ok) return;
    }
    dlBtn.disabled = true;
    dlBtn.innerHTML = `<span class="spin" style="display:flex">${icon('spinner', 15)}</span> Downloading…`;
    await downloadAllTracks(tracks, {});
    dlBtn.disabled = false;
    dlBtn.innerHTML = `${icon('download', 15)} Download all`;
  };
  host.querySelector('#sm-edit').onclick = () => { location.hash = `#/smart/${id}/edit`; };
  host.querySelector('#sm-delete').onclick = async () => {
    const ok = await confirmDialog({
      title: `Delete “${sp.name}”?`,
      message: 'The rules are removed. Tracks, playlists and downloads are untouched.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.smartDelete(id);
      toastOk('Smart playlist deleted');
      location.hash = '#/library';
    } catch { toastErr('Delete failed'); }
  };
  return {};
}

// ────────────────────────────────────────────── editor

async function mountEditor(root, existing, seedSpec) {
  const isNew = !existing;
  let presets = [];
  try { presets = (await api.smartPresets()).presets; } catch { /* cosmetic */ }

  const spec = {
    match: seedSpec.match === 'any' ? 'any' : 'all',
    rules: (seedSpec.rules || []).map(r => ({ ...r })),
    order: seedSpec.order || 'most_played',
    limit: seedSpec.limit || 50,
  };
  let emoji = existing?.emoji || 'icon:sparkles';

  root.innerHTML = `
    <div style="max-width:760px" id="sm-ed">
      <div class="section-head-row" style="margin-bottom:14px">
        <h1 style="font-size:26px">${isNew ? 'New smart playlist' : 'Edit rules'}</h1>
        <span class="faint" style="font-size:12.5px">rebuilds itself from your library</span>
      </div>

      <div class="card" style="padding:18px">
        <div class="field">
          <label for="sm-ed-name">Name</label>
          <input id="sm-ed-name" class="input" maxlength="120" placeholder="e.g. On repeat">
        </div>
        <div class="field" style="margin-top:10px">
          <label>Cover</label>
          <div class="chip-row" id="sm-ed-emoji"></div>
        </div>

        <div class="field" style="margin-top:18px">
          <label>Rules — a track must match
            <span class="chip-row" style="display:inline-flex;vertical-align:middle;margin-left:6px">
              <button class="chip" data-match="all">all</button>
              <button class="chip" data-match="any">any</button>
            </span>
          </label>
          <div id="sm-ed-rules"></div>
          <button class="btn ghost" id="sm-ed-addrule" style="margin-top:8px">${icon('plus', 14)} Add rule</button>
        </div>

        <div class="row" style="gap:16px;margin-top:18px;flex-wrap:wrap">
          <div class="field">
            <label for="sm-ed-order">Order</label>
            <select id="sm-ed-order" class="input"></select>
          </div>
          <div class="field">
            <label for="sm-ed-limit">Max tracks</label>
            <input id="sm-ed-limit" class="input" type="number" min="1" max="500" style="width:90px">
          </div>
        </div>

        <div class="row" style="justify-content:space-between;margin-top:18px;flex-wrap:wrap;gap:10px">
          <span class="faint" id="sm-ed-preview" style="font-size:13px">…</span>
          <span class="row" style="gap:8px">
            <button class="btn ghost" id="sm-ed-cancel">Cancel</button>
            <button class="btn primary" id="sm-ed-save">${isNew ? 'Create' : 'Save'}</button>
          </span>
        </div>
      </div>

      ${isNew && presets.length ? `
        <div style="margin-top:18px">
          <div class="faint" style="font-size:12.5px;margin-bottom:8px">…or start from a ready-made one:</div>
          <div class="chip-row" id="sm-ed-presets"></div>
        </div>` : ''}
    </div>`;

  const $ = sel => root.querySelector(sel);
  $('#sm-ed-name').value = existing?.name || '';
  $('#sm-ed-limit').value = spec.limit;

  // cover picker (SVG icons)
  const emojiHost = $('#sm-ed-emoji');
  const paintEmoji = () => {
    emojiHost.innerHTML = '';
    COVER_ICONS.forEach(name => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${emoji === `icon:${name}` ? ' on' : ''}`;
      b.style.cssText = 'padding:8px 10px;display:flex';
      b.innerHTML = icon(name, 16, emoji === `icon:${name}`);
      b.onclick = () => {
        emoji = `icon:${name}`;
        paintEmoji();
      };
      emojiHost.appendChild(b);
    });
  };
  paintEmoji();

  // match all/any
  const paintMatch = () => {
    root.querySelectorAll('[data-match]').forEach(b =>
      b.classList.toggle('on', b.dataset.match === spec.match));
  };
  root.querySelectorAll('[data-match]').forEach(b => {
    b.onclick = () => { spec.match = b.dataset.match; paintMatch(); schedulePreview(); };
  });
  paintMatch();

  // order select
  const orderSel = $('#sm-ed-order');
  ORDERS.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    orderSel.appendChild(o);
  });
  orderSel.value = spec.order;
  orderSel.onchange = () => { spec.order = orderSel.value; schedulePreview(); };
  $('#sm-ed-limit').onchange = () => { spec.limit = clampLimit($('#sm-ed-limit').value); schedulePreview(); };

  // rules
  const rulesHost = $('#sm-ed-rules');
  function ruleRow(rule, idx) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap';
    const fieldSel = document.createElement('select');
    fieldSel.className = 'input';
    Object.entries(FIELDS).forEach(([v, f]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = f.label;
      fieldSel.appendChild(o);
    });
    fieldSel.value = rule.field;
    const opSel = document.createElement('select');
    opSel.className = 'input';
    const valHost = document.createElement('span');
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'Remove rule';
    del.innerHTML = icon('close', 15);
    del.onclick = () => { spec.rules.splice(idx, 1); paintRules(); schedulePreview(); };

    const paintOps = () => {
      const kind = FIELDS[rule.field].kind;
      opSel.innerHTML = '';
      OPS[kind].forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        opSel.appendChild(o);
      });
      if (!OPS[kind].some(([v]) => v === rule.op)) rule.op = OPS[kind][0][0];
      opSel.value = rule.op;
      paintValue();
    };
    const paintValue = () => {
      valHost.innerHTML = '';
      const kind = FIELDS[rule.field].kind;
      if (rule.op === 'never') return;
      if (kind === 'enum') {
        const s = document.createElement('select');
        s.className = 'input';
        SOURCES.forEach(([v, label]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = label;
          s.appendChild(o);
        });
        if (rule.value !== 'local' && rule.value !== 'youtube') rule.value = 'youtube';
        s.value = rule.value;
        s.onchange = () => { rule.value = s.value; schedulePreview(); };
        valHost.appendChild(s);
      } else if (kind === 'bool') {
        const s = document.createElement('select');
        s.className = 'input';
        [['1', 'yes'], ['0', 'no']].forEach(([v, label]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = label;
          s.appendChild(o);
        });
        s.value = rule.value ? '1' : '0';
        s.onchange = () => { rule.value = s.value === '1'; schedulePreview(); };
        valHost.appendChild(s);
      } else {
        const i = document.createElement('input');
        i.className = 'input';
        i.type = kind === 'text' ? 'text' : 'number';
        i.placeholder = kind === 'text' ? FIELDS[rule.field].label.toLowerCase()
          : kind === 'seconds' ? 'minutes' : kind === 'days' ? 'days' : '';
        i.style.width = kind === 'text' ? '180px' : '90px';
        if (kind === 'seconds') i.value = rule.value ? Math.round(rule.value / 60) : '';
        else if (kind === 'int' || kind === 'days') i.value = rule.value ?? '';
        else i.value = rule.value || '';
        i.oninput = () => {
          if (kind === 'text') rule.value = i.value;
          else if (kind === 'seconds') rule.value = Math.max(0, Number(i.value) || 0) * 60;
          else rule.value = Number(i.value) || 0;
          schedulePreview();
        };
        valHost.appendChild(i);
      }
    };
    fieldSel.onchange = () => {
      rule.field = fieldSel.value;
      rule.op = OPS[FIELDS[rule.field].kind][0][0];
      rule.value = FIELDS[rule.field].kind === 'bool' ? true : FIELDS[rule.field].kind === 'enum' ? 'youtube' : undefined;
      paintOps(); schedulePreview();
    };
    opSel.onchange = () => { rule.op = opSel.value; paintValue(); schedulePreview(); };

    row.append(fieldSel, opSel, valHost, del);
    paintOps();
    return row;
  }

  function paintRules() {
    rulesHost.innerHTML = '';
    if (!spec.rules.length) {
      const hint = document.createElement('div');
      hint.className = 'faint';
      hint.style.cssText = 'font-size:13px;padding:6px 0';
      hint.textContent = 'No rules — matches every track in your library.';
      rulesHost.appendChild(hint);
    }
    spec.rules.forEach((r, i) => rulesHost.appendChild(ruleRow(r, i)));
  }
  $('#sm-ed-addrule').onclick = () => {
    if (spec.rules.length >= 12) { toastErr('12 rules max'); return; }
    spec.rules.push({ field: 'last_played', op: 'within', value: 30 });
    paintRules(); schedulePreview();
  };
  paintRules();

  // presets (create mode)
  const presetHost = $('#sm-ed-presets');
  if (presetHost) {
    presets.forEach(p => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = `${smartCoverArt(p.emoji, 13)}<span style="margin-left:6px"></span>`;
      b.querySelector('span').textContent = p.name;
      b.onclick = () => {
        $('#sm-ed-name').value = p.name;
        emoji = p.emoji;
        paintEmoji();
        Object.assign(spec, JSON.parse(JSON.stringify(p.spec)));
        $('#sm-ed-limit').value = spec.limit;
        orderSel.value = spec.order;
        paintMatch(); paintRules(); schedulePreview();
      };
      presetHost.appendChild(b);
    });
  }

  // live preview (server computes the count with the same SQL it will use)
  let previewTimer = 0;
  let previewSeq = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 350);
  }
  async function runPreview() {
    const seq = ++previewSeq;
    $('#sm-ed-preview').textContent = '…';
    try {
      const stats = await api.smartPreview(currentSpec());
      if (seq !== previewSeq) return;
      $('#sm-ed-preview').innerHTML =
        `<b style="color:var(--fg)">${stats.count}</b> track${stats.count === 1 ? '' : 's'} match · ${fmtDurLong(stats.seconds)}`;
    } catch (e) {
      if (seq !== previewSeq) return;
      $('#sm-ed-preview').textContent = e.detail || 'Rules look invalid';
    }
  }

  function currentSpec() {
    spec.limit = clampLimit($('#sm-ed-limit').value);
    return { ...spec, rules: spec.rules.filter(r => FIELDS[r.field]) };
  }

  $('#sm-ed-cancel').onclick = () => {
    location.hash = existing ? `#/smart/${existing.id}` : '#/library';
  };
  $('#sm-ed-save').onclick = async () => {
    const name = $('#sm-ed-name').value.trim();
    if (!name) { toastErr('Give it a name first'); $('#sm-ed-name').focus(); return; }
    const specOut = currentSpec();
    try {
      if (isNew) {
        const created = await api.smartCreate(name, specOut, emoji);
        location.hash = `#/smart/${created.id}`;
      } else {
        await api.smartUpdate(existing.id, { name, spec: specOut, emoji });
        location.hash = `#/smart/${existing.id}`;
      }
      toastOk(isNew ? 'Smart playlist created' : 'Rules saved');
    } catch (e) {
      toastErr(e.detail || 'Save failed');
    }
  };

  schedulePreview();
  return {};
}

function clampLimit(v) {
  return Math.min(500, Math.max(1, Math.round(Number(v) || 50)));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
