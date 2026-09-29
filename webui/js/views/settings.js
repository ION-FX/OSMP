// Settings — appearance, AI curator, security, playback, server info.

import { api, fmtBytes } from '../api.js';
import { get, set, load, persist } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { THEMES, ACCENTS, applyTheme, applyAccent, applyMotion } from '../theme.js';
import { refreshPlaylistsDeep, refreshPlaylists } from '../actions.js';
import { getEq, setBand, applyPreset, PRESETS, resetEq, toggleBypass, isBypassed } from '../eq.js';
import { confirmDialog } from '../components/dialog.js';

export async function mount(root) {
  let serverSettings = {};
  try { serverSettings = await api.settings(); } catch (e) { console.warn(e); }

  const cfg = get('config') || {};
  const curTheme = document.documentElement.dataset.theme || 'dark';
  const curAccent = Number(getComputedStyle(document.documentElement).getPropertyValue('--accent-h')) || 178;

  root.innerHTML = `
    <div class="view-head"><h1>Settings</h1></div>

    <section class="section">
      <div class="section-head-row"><h2>${icon('palette', 19)} &nbsp;Appearance</h2></div>
      <div class="card" style="cursor:default">
        <div class="field" style="margin-bottom:18px">
          <label>Theme</label>
          <div class="chip-row" id="st-themes"></div>
        </div>
        <div class="field" style="margin-bottom:18px">
          <label>Accent color</label>
          <div class="chip-row" id="st-accents"></div>
        </div>
        <div class="field">
          <label class="row gap-m" style="cursor:pointer">
            <input type="checkbox" id="st-motion" style="width:17px;height:17px;accent-color:var(--accent)">
            <span>Background animations <span class="faint">(drifting aurora mesh)</span></span>
          </label>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head-row">
        <h2>${icon('sparkles', 19)} &nbsp;AI Curator <span id="st-llm-badge"></span></h2>
      </div>
      <div class="card" style="cursor:default">
        <p class="dim" style="font-size:13px;margin-bottom:16px">
          Any OpenAI-compatible API works: OpenAI, OpenRouter, Groq, LM Studio, or a local Ollama
          (e.g. <span class="mono">http://localhost:11434/v1</span>). Keys are stored on your server only.
        </p>
        <div class="field" style="margin-bottom:12px">
          <label>Base URL</label>
          <input class="input mono" id="st-llm-url" placeholder="https://api.openai.com/v1" value="">
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>API key <span class="faint">(leave empty for local servers)</span></label>
          <input class="input mono" id="st-llm-key" type="password" placeholder="sk-…">
        </div>
        <div class="field" style="margin-bottom:16px">
          <label>Model</label>
          <input class="input mono" id="st-llm-model" placeholder="gpt-4o-mini" value="">
        </div>
        <div class="row gap-m">
          <button class="btn primary" id="st-llm-save">Save</button>
          <button class="btn ghost" id="st-llm-test">Test connection</button>
        </div>
        <div id="st-llm-result" style="margin-top:12px;font-size:13px"></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head-row"><h2>${icon('sliders', 19)} &nbsp;Sound</h2></div>
      <div class="card" style="cursor:default" id="st-eq-card">
        <div class="field" style="margin-bottom:18px">
          <label>Equalizer preset</label>
          <div class="chip-row" id="st-eq-presets"></div>
        </div>
        <div class="field" style="margin-bottom:14px">
          <label class="row gap-m" style="cursor:pointer">
            <input type="checkbox" id="st-eq-bypass" style="width:16px;height:16px;accent-color:var(--accent)">
            <span>Equalizer on</span>
          </label>
        </div>
        <div class="eq-bands" id="st-eq-bands"></div>
        <div class="hint" id="st-eq-hint">Applies live while music plays — changes are saved for this device.</div>
      </div>
    </section>

    <section class="section" id="st-scan-sec">
      <div class="section-head-row"><h2>${icon('upload', 19)} &nbsp;Import your collection</h2></div>
      <div class="card" style="cursor:default">
        <p class="dim" style="font-size:13px;margin-bottom:14px">
          Point OSMP at a folder on this machine — every audio file inside (mp3, m4a, flac,
          ogg, opus, wav…) is <strong>copied</strong> into your library with tags and cover art
          read automatically. Nothing is moved or deleted from the source folder; big
          collections can take a minute.
        </p>
        <div class="row gap-m" style="flex-wrap:wrap">
          <input class="input mono" id="st-scan-path" placeholder="/home/you/Music"
                 style="max-width:380px" spellcheck="false">
          <button class="btn primary" id="st-scan-go">${icon('upload', 15)} Scan folder</button>
        </div>
        <div id="st-scan-result" style="margin-top:12px;font-size:13.5px"></div>
      </div>
    </section>

    <section class="section" id="st-backup-sec">
      <div class="section-head-row"><h2>${icon('database', 19)} &nbsp;Backup &amp; restore</h2></div>
      <div class="card" style="cursor:default">
        <p class="dim" style="font-size:13px;margin-bottom:14px">
          One JSON file with your playlists, track metadata and appearance settings.
          Accounts, API keys and downloads stay on this server — the backup is safe to
          import anywhere.
        </p>
        <div class="row gap-m" style="flex-wrap:wrap">
          <button class="btn primary" id="st-backup-export">${icon('download', 15)} Export library</button>
          <button class="btn ghost" id="st-backup-import">${icon('database', 15)} Import backup…</button>
          <input type="file" id="st-backup-file" accept="application/json,.json" class="hidden">
        </div>
        <div id="st-backup-result" style="margin-top:12px;font-size:13px"></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head-row"><h2>${icon('zap', 19)} &nbsp;Updates</h2></div>
      <div class="card" style="cursor:default">
        <div class="row gap-m" style="margin-bottom:14px;flex-wrap:wrap">
          <span class="dim" id="up-now" style="font-size:13.5px"></span>
          <span class="spacer"></span>
          <span id="up-badge" class="faint" style="font-size:12px"></span>
        </div>
        <div class="row gap-m" style="flex-wrap:wrap" id="up-actions">
          <button class="btn ghost" id="up-check">${icon('info', 15)} Check for updates</button>
          <button class="btn primary hidden" id="up-apply">${icon('download', 15)} Update now</button>
          <button class="btn ghost" id="up-ytdlp" title="When YouTube changes and videos stop playing, this pulls the newest extractor">${icon('zap', 15)} Update yt-dlp only</button>
          <a class="btn ghost" id="up-releases" href="${'https://github.com/ION-FX/OSMP/releases'}" target="_blank" rel="noreferrer">${icon('link', 15)} Releases page</a>
        </div>
        <div id="up-note" class="dim hidden" style="margin-top:12px;font-size:13px"></div>
        <div class="field" style="margin-top:14px" id="up-token-field">
          <label>GitHub token <span class="faint">(optional for public repos; needed for private ones)</span></label>
          <div class="row gap-m">
            <input class="input mono" id="up-token" type="password" placeholder="${serverSettings.github_token ? '•••• (set)' : 'github_pat_… / ghp_…'}" style="max-width:380px">
            <button class="btn ghost" id="up-token-save">Save</button>
          </div>
          <div class="hint">Stored on the server only. Used to check releases and pull code.</div>
        </div>
        <pre id="up-log" class="mono hidden" style="margin-top:14px;background:var(--bg-2);border-radius:var(--r-sm);padding:12px;font-size:11.5px;line-height:1.55;max-height:220px;overflow:auto;white-space:pre-wrap"></pre>
      </div>
    </section>

    <section class="section">
      <div class="section-head-row"><h2>${icon('server', 19)} &nbsp;Playback & server</h2></div>
      <div class="card" style="cursor:default">
        <div class="field" style="margin-bottom:16px">
          <label>Stream format</label>
          <select class="select" id="st-format" style="max-width:320px">
            <option value="auto">Auto — picks what this device can play</option>
            <option value="m4a">m4a / AAC — works everywhere incl. Safari</option>
            <option value="opus">Opus / WebM — best quality, Chromium browsers</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:16px">
          <label>Saved on this device <span class="faint">(offline audio in this browser)</span></label>
          <div class="row gap-m" style="align-items:center">
            <span class="dim" style="font-size:13.5px" id="st-dev-count"></span>
            <button class="btn ghost" id="st-dev-clear" style="display:none">Clear</button>
          </div>
          <div class="hint">"Save to this device" on any track's ⋮ menu keeps it playable with the server down.</div>
        </div>
        <div id="st-server-info" class="dim" style="font-size:13px;line-height:1.9"></div>
      </div>
    </section>

    <section class="section" id="st-accounts">
      <div class="section-head-row"><h2>${icon('user', 19)} &nbsp;Accounts</h2></div>
      <div class="card" style="cursor:default">
        <div class="field" style="margin-bottom:16px">
          <label>My password</label>
          <div class="row gap-m" style="max-width:460px">
            <input class="input" id="st-my-pass" type="password" placeholder="New password (min 4 chars)" maxlength="128">
            <button class="btn ghost" id="st-my-pass-save">Change</button>
          </div>
          <div class="hint">You'll be signed out and asked to log in again.</div>
        </div>
        <div id="st-users-admin" class="hidden">
          <div class="section-head-row" style="margin-bottom:10px">
            <label style="font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:var(--text-faint);font-weight:700">Users</label>
          </div>
          <div id="st-users-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px"></div>
          <div class="row gap-m" style="flex-wrap:wrap">
            <input class="input" id="st-new-user" placeholder="Username" maxlength="32" style="max-width:170px" spellcheck="false">
            <input class="input" id="st-new-pass" type="password" placeholder="Password" maxlength="128" style="max-width:170px">
            <select class="select" id="st-new-role" style="max-width:130px">
              <option value="user">Listener</option>
              <option value="admin">Admin</option>
            </select>
            <button class="btn primary" id="st-user-add">${icon('plus', 15)} Add user</button>
          </div>
          <div class="hint">Listeners can stream, build playlists and download — only admins manage users, settings and updates.</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head-row"><h2>${icon('info', 19)} &nbsp;About</h2></div>
      <div class="card" style="cursor:default">
        <div class="row gap-m" style="margin-bottom:10px">
          <strong style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:17px;letter-spacing:.14em">OSMP</strong>
          <span class="faint">v${cfg.version || '?'} · Open-Source Music Player</span>
        </div>
        <p class="dim" style="font-size:13px;max-width:70ch">
          Self-hosted, YouTube-backed music streaming with offline downloads, algorithmic radio
          and optional LLM curation. Runs as a server, a Linux AppImage, an Android app, or right
          here in your browser.
        </p>
        <p class="faint" style="font-size:12px;margin-top:10px;max-width:70ch">
          Intended for personal use with content you have the right to play. YouTube streaming may
          be subject to YouTube's Terms of Service in your jurisdiction.
        </p>
      </div>
    </section>
  `;

  // ── appearance ──
  const themesHost = root.querySelector('#st-themes');
  THEMES.forEach(t => {
    const c = document.createElement('button');
    c.className = `chip ${t.id === curTheme ? 'on' : ''}`;
    c.innerHTML = `${icon(t.icon, 14)} ${t.label}`;
    c.onclick = () => {
      applyTheme(t.id);
      themesHost.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
      c.classList.add('on');
    };
    themesHost.appendChild(c);
  });

  const accentsHost = root.querySelector('#st-accents');
  ACCENTS.forEach(a => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.title = a.name;
    c.style.padding = '6px';
    c.innerHTML = `<span style="width:26px;height:26px;border-radius:50%;display:block;
      background:linear-gradient(135deg, hsl(${a.h} 85% 52%), hsl(${a.h + 82} 85% 62%));
      ${Math.abs(a.h - curAccent) < 8 ? 'outline:2.5px solid var(--text);outline-offset:2px' : ''}"></span>`;
    c.onclick = () => {
      applyAccent(a.h);
      accentsHost.querySelectorAll('.chip span').forEach(x => { x.style.outline = 'none'; });
      c.querySelector('span').style.outline = '2.5px solid var(--text)';
      c.querySelector('span').style.outlineOffset = '2px';
    };
    accentsHost.appendChild(c);
  });

  const motion = root.querySelector('#st-motion');
  motion.checked = load('motion', true);
  motion.onchange = () => applyMotion(motion.checked);

  // ── LLM ──
  const llmUrl = root.querySelector('#st-llm-url');
  const llmKey = root.querySelector('#st-llm-key');
  const llmModel = root.querySelector('#st-llm-model');
  llmUrl.value = serverSettings.llm_base_url || '';
  llmModel.value = serverSettings.llm_model || '';
  const badge = root.querySelector('#st-llm-badge');
  const paintBadge = (ok) => {
    badge.textContent = ok ? '● connected' : '○ not configured';
    badge.style.cssText = `font-size:11px;font-weight:700;color:${ok ? 'hsl(140 70% 55%)' : 'var(--text-faint)'}`;
  };
  paintBadge(!!serverSettings.llm_configured);

  root.querySelector('#st-llm-save').onclick = async () => {
    const patch = {
      llm_base_url: llmUrl.value.trim(),
      llm_model: llmModel.value.trim(),
    };
    if (llmKey.value.trim()) patch.llm_api_key = llmKey.value.trim();
    if (!llmUrl.value.trim()) patch.llm_api_key = '';
    try {
      await api.saveSettings(patch);
      const cfg2 = await api.config();
      set({ config: cfg2 }, false);
      paintBadge(cfg2.llm_configured);
      llmKey.value = '';
      toastOk('AI curator settings saved');
    } catch (e) { toastErr('Save failed'); }
  };

  root.querySelector('#st-llm-test').onclick = async () => {
    const out = root.querySelector('#st-llm-result');
    out.innerHTML = `<span class="dim">${icon('spinner', 14)} Testing…</span>`;
    out.querySelector('svg')?.classList.add('spin');
    try {
      const res = await api.llmCurate('one iconic song, any genre', 1);
      out.innerHTML = `<span style="color:hsl(140 70% 55%)">✓ Working — got “${escapeHtml(res.tracks[0]?.title || '?')}” via ${escapeHtml(res.model)}</span>`;
    } catch (e) {
      out.innerHTML = `<span style="color:hsl(4 85% 65%)">✗ ${escapeHtml(e.detail || e.message)}</span>`;
    }
  };

  // ── playback / server ──
  const fmtSel = root.querySelector('#st-format');
  fmtSel.value = load('format', 'auto');
  fmtSel.onchange = () => {
    persist('format', fmtSel.value);
    localStorage.setItem('osmp.format', fmtSel.value);
    toastOk(`Stream format: ${fmtSel.value}`);
  };

  root.querySelector('#st-pin-save')?.remove();

  // saved-on-this-device
  {
    const ids = load('deviceOffline', []);
    const countEl = root.querySelector('#st-dev-count');
    countEl.textContent = `${ids.length} track${ids.length === 1 ? '' : 's'} saved offline`;
    const clearBtn = root.querySelector('#st-dev-clear');
    if (ids.length) {
      clearBtn.style.display = '';
      clearBtn.onclick = async () => {
        try {
          if ('caches' in window) await caches.delete('osmp-audio-v1');
        } catch { /* */ }
        persist('deviceOffline', []);
        countEl.textContent = '0 tracks saved offline';
        clearBtn.style.display = 'none';
        toastOk('Cleared saved audio from this device');
      };
    }
  }

  // ── accounts ──
  const me = cfg.user || null;
  root.querySelector('#st-my-pass-save').onclick = async () => {
    const v = root.querySelector('#st-my-pass').value;
    if (!me) { toastErr('Not signed in'); return; }
    if (v.length < 4) { toast('Password must be at least 4 characters'); return; }
    try {
      await api.setUserPassword(me.id, v);
      toastOk('Password changed — signing you out');
      setTimeout(async () => { await api.logout().catch(() => {}); location.reload(); }, 900);
    } catch (e) { toastErr(e.detail || 'Change failed'); }
  };

  if (me && me.role === 'admin') {
    const adminBox = root.querySelector('#st-users-admin');
    adminBox.classList.remove('hidden');
    const listHost = root.querySelector('#st-users-list');
    const renderUsers = async () => {
      let users = [];
      try { users = (await api.users()).users; } catch (e) { return; }
      listHost.innerHTML = '';
      users.forEach(u => {
        const row = document.createElement('div');
        row.className = 'row gap-m';
        row.style.cssText = 'align-items:center;padding:9px 12px;background:var(--bg-2);border-radius:var(--r-sm)';
        row.innerHTML = `
          <span style="display:flex">${icon('user', 16)}</span>
          <strong style="font-size:13.5px"></strong>
          ${u.role === 'admin' ? '<span class="nav-badge beta">admin</span>' : '<span class="faint" style="font-size:12px">listener</span>'}
          <span class="spacer"></span>
          <button class="icon-btn sm" title="Reset password">${icon('edit', 15)}</button>
          ${u.id !== me.id ? `<button class="icon-btn sm" title="Remove user">${icon('trash', 15)}</button>` : '<span class="faint" style="font-size:12px">you</span>'}`;
        row.querySelector('strong').textContent = u.username;
        const [pwBtn, delBtn] = row.querySelectorAll('.icon-btn');
        pwBtn.onclick = async () => {
          const np = prompt(`New password for ${u.username}:`);
          if (!np) return;
          try { await api.setUserPassword(u.id, np); toastOk(`Password reset for ${u.username}`); }
          catch (e) { toastErr(e.detail || 'Reset failed'); }
        };
        if (delBtn && delBtn.tagName === 'BUTTON') {
          delBtn.onclick = async () => {
            if (!confirm(`Remove ${u.username}? Their history will be deleted.`)) return;
            try { await api.deleteUser(u.id); toast(`Removed ${u.username}`, { icon: 'trash' }); renderUsers(); }
            catch (e) { toastErr(e.detail || 'Remove failed'); }
          };
        }
        listHost.appendChild(row);
      });
    };
    renderUsers();
    root.querySelector('#st-user-add').onclick = async () => {
      const un = root.querySelector('#st-new-user').value.trim();
      const pw = root.querySelector('#st-new-pass').value;
      const role = root.querySelector('#st-new-role').value;
      if (!un || pw.length < 4) { toast('Username and a 4+ char password, please'); return; }
      try {
        await api.createUser(un, pw, role);
        root.querySelector('#st-new-user').value = '';
        root.querySelector('#st-new-pass').value = '';
        toastOk(`Added ${un}`);
        renderUsers();
      } catch (e) { toastErr(e.detail || 'Could not add user'); }
    };
  }

  // server info
  let libSize = 0, libCount = 0;
  try {
    const lib = await api.library(true);
    libCount = lib.tracks.length;
    libSize = lib.tracks.reduce((s, t) => s + (t.file_size || 0), 0);
  } catch { /* offline */ }
  root.querySelector('#st-server-info').innerHTML = `
    <div>${icon('server', 14)} Server v${cfg.version || '?'} · ffmpeg ${cfg.ffmpeg ? '✓' : '✗ (downloads may need it)'}</div>
    <div>${icon('download', 14)} Library: ${libCount} tracks offline · ${fmtBytes(libSize)} on disk</div>
    <div>${icon('cloud-off', 14)} Playback offline: downloads play with no network at all</div>
    ${window.OsmpBridge ? `<div>${icon('disc', 14)} Running inside the OSMP Android app</div>` : ''}`;

  // ── equalizer ─────────────────────────────────────────────────────
  {
    const eqCard = root.querySelector('#st-eq-card');
    if (!getEq().supported) {
      eqCard.innerHTML = `
        <p class="dim" style="font-size:13px">This browser doesn't expose Web Audio,
        so the equalizer isn't available here.</p>`;
    } else {
      const presetsHost = root.querySelector('#st-eq-presets');
      const bandsHost = root.querySelector('#st-eq-bands');
      const bypassBox = root.querySelector('#st-eq-bypass');
      bypassBox.checked = !isBypassed();
      bypassBox.onchange = () => toggleBypass(!bypassBox.checked);
      const paint = () => {
        const eq = getEq();
        presetsHost.innerHTML = '';
        [...Object.keys(PRESETS), ...(eq.preset === 'Custom' ? ['Custom'] : [])].forEach(name => {
          const c = document.createElement('button');
          c.className = `chip${name === eq.preset ? ' on' : ''}`;
          c.textContent = name;
          if (name === 'Custom') {
            c.title = 'Your current slider positions';
            c.onclick = () => { /* already custom — nothing to reapply */ };
          } else {
            c.onclick = () => { applyPreset(name); paint(); };
          }
          presetsHost.appendChild(c);
        });
        bandsHost.innerHTML = '';
        eq.bands.forEach(b => {
          const row = document.createElement('div');
          row.className = 'eq-band';
          row.innerHTML = `
            <div class="eq-band-top">
              <label>${escapeHtml(b.label)}</label>
              <span class="eq-band-db mono" data-db="${b.id}">${b.db > 0 ? '+' : ''}${b.db.toFixed(1)}</span>
            </div>
            <input type="range" min="-12" max="12" step="0.5" value="${b.db}"
                   data-band="${b.id}" aria-label="${escapeHtml(b.label)} gain">
            <div class="eq-band-ends"><span>-12</span><span>0</span><span>+12</span></div>`;
          const slider = row.querySelector('input');
          slider.addEventListener('input', () => {
            setBand(b.id, parseFloat(slider.value));
            row.querySelector('.eq-band-db').textContent =
              `${slider.value > 0 ? '+' : ''}${(+slider.value).toFixed(1)}`;
          });
          slider.addEventListener('change', paint);  // re-chip presets on release
          bandsHost.appendChild(row);
        });
      };
      paint();
    }
  }

  // ── server-folder scan (admin) ────────────────────────────────────
  {
    const sec = root.querySelector('#st-scan-sec');
    if ((cfg.user || {}).role !== 'admin') {
      sec.remove();
    } else {
      const out = root.querySelector('#st-scan-result');
      const go = root.querySelector('#st-scan-go');
      root.querySelector('#st-scan-go').onclick = async () => {
        const path = root.querySelector('#st-scan-path').value.trim();
        if (!path) { toast('Type a folder path first'); return; }
        go.disabled = true;
        out.innerHTML = `<span class="dim">${icon('spinner', 14)} Scanning — this can take a while…</span>`;
        out.querySelector('svg')?.classList.add('spin');
        try {
          const r = await api.scanLibrary(path);
          const bits = [
            `<strong>${r.imported}</strong> imported`,
            r.duplicates ? `${r.duplicates} already there` : '',
            r.errors?.length ? `${r.errors.length} failed` : '',
          ].filter(Boolean).join(' · ');
          out.innerHTML = `<span style="color:hsl(140 70% 55%)">✓</span> ${bits} <span class="faint">(scanned ${r.scanned} files)</span>`;
          if (r.errors?.length) {
            out.innerHTML += `<div class="faint" style="margin-top:6px;font-size:12px">${r.errors.slice(0, 5).map(escapeHtml).join('<br>')}</div>`;
          }
          if (r.imported) toastOk(`Imported ${r.imported} tracks`, { icon: 'upload' });
        } catch (e) {
          out.textContent = '';
          toastErr(e.detail || 'Scan failed');
        } finally {
          go.disabled = false;
        }
      };
    }
  }

  // ── backup & restore (admin) ──────────────────────────────────────
  {
    const sec = root.querySelector('#st-backup-sec');
    if ((cfg.user || {}).role !== 'admin') {
      sec.remove();
    } else {
      const result = root.querySelector('#st-backup-result');
      root.querySelector('#st-backup-export').onclick = async () => {
        result.textContent = 'Preparing backup…';
        try {
          const res = await fetch('/api/backup', { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `osmp-backup-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          result.textContent = '';
          toastOk('Backup downloaded');
        } catch (e) {
          result.textContent = '';
          toastErr(e.message || 'Export failed');
        }
      };
      const fileIn = root.querySelector('#st-backup-file');
      root.querySelector('#st-backup-import').onclick = () => fileIn.click();
      fileIn.onchange = async () => {
        const file = fileIn.files && fileIn.files[0];
        fileIn.value = '';
        if (!file) return;
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          toastErr('That file isn’t valid JSON');
          return;
        }
        if (data.format && data.format !== 'osmp-backup') {
          toastErr('Not an OSMP backup file');
          return;
        }
        const nPl = (data.playlists || []).length;
        const nTr = (data.tracks || []).length;
        const ok = await confirmDialog({
          title: 'Import backup?',
          message: `${nPl} playlist${nPl === 1 ? '' : 's'} · ${nTr} tracks. Playlists with the same name are merged — nothing is deleted.`,
          confirmLabel: 'Import',
        });
        if (!ok) return;
        result.textContent = 'Importing…';
        try {
          const r = await api.backupRestore(data);
          result.textContent = `Created ${r.playlists_created} · merged ${r.playlists_merged} · unchanged ${r.playlists_unchanged}`;
          await refreshPlaylists();
          toastOk('Backup imported');
        } catch (e) {
          result.textContent = '';
          toastErr(e.detail || 'Import failed');
        }
      };
    }
  }

  // ── updates ──────────────────────────────────────────────────────
  const upNow = root.querySelector('#up-now');
  const upBadge = root.querySelector('#up-badge');
  const upNote = root.querySelector('#up-note');
  const upLog = root.querySelector('#up-log');
  const upApply = root.querySelector('#up-apply');
  const cfgNow = get('config') || {};
  upNow.textContent = `OSMP v${cfgNow.version || '?'}` +
    (cfgNow.commit ? ` · build ${cfgNow.commit}` : '') +
    (cfgNow.update_mode === 'appimage' ? ' · AppImage'
      : cfgNow.update_mode === 'source' ? ' · source install' : '');

  const onAndroid = !!window.OsmpBridge;
  const isAdmin = (cfgNow.user || {}).role === 'admin';
  if (!isAdmin && !onAndroid) {
    // listeners can't manage the server install
    root.querySelector('#up-check').classList.add('hidden');
    root.querySelector('#up-ytdlp').classList.add('hidden');
    root.querySelector('#up-token-field').classList.add('hidden');
    upBadge.textContent = 'ask an admin';
  }
  if (onAndroid) {
    // APKs update by installing the new release — hide in-place actions
    root.querySelector('#up-check').classList.add('hidden');
    root.querySelector('#up-ytdlp').classList.add('hidden');
    root.querySelector('#up-token-field').classList.add('hidden');
    root.querySelector('#up-releases').classList.add('primary');
    root.querySelector('#up-releases').innerHTML =
      `${icon('download', 15)} Get the latest APK`;
    upBadge.textContent = 'on-device';
  }

  const saveToken = async () => {
    const v = root.querySelector('#up-token').value.trim();
    if (!v) { toast('Paste a token first'); return; }
    try {
      await api.saveSettings({ github_token: v });
      root.querySelector('#up-token').value = '';
      toastOk('Token saved — update checks enabled');
    } catch (e) { toastErr(e.detail || 'Save failed'); }
  };
  root.querySelector('#up-token-save').onclick = saveToken;

  const appendLog = (lines) => {
    upLog.classList.remove('hidden');
    upLog.textContent = (lines || []).join('\n');
    upLog.scrollTop = upLog.scrollHeight;
  };

  const pollJob = (jobId) => new Promise(resolve => {
    const tick = async () => {
      try {
        const data = await api.updateStatus(jobId);
        appendLog(data.lines);
        if (data.phase === 'restarting') return resolve(data);
        if (data.status === 'done' || data.status === 'error') return resolve(data);
      } catch { /* server restarting — keep waiting */ }
      setTimeout(tick, 1200);
    };
    tick();
  });

  const waitBackAndReload = () => {
    upNote.classList.remove('hidden');
    upNote.textContent = 'Update applied — waiting for the server to come back…';
    let tries = 0;
    const ping = async () => {
      try {
        const r = await fetch(`/api/health?cb=${Date.now()}`, { credentials: 'same-origin' });
        if (r.ok) { location.reload(); return; }
      } catch { /* not up yet */ }
      if (++tries < 90) setTimeout(ping, 1500);
      else upNote.textContent = 'Server did not come back within 2 minutes — check server.log.';
    };
    setTimeout(ping, 2500);
  };

  const runUpdate = async (kind) => {
    try {
      upApply.disabled = true;
      root.querySelector('#up-ytdlp').disabled = true;
      upNote.classList.remove('hidden');
      upNote.textContent = kind === 'ytdlp'
        ? 'Refreshing the YouTube extractor…'
        : 'Updating OSMP — hang tight, the server restarts itself…';
      const { job_id } = await api.updateApply(kind);
      const final = await pollJob(job_id);
      upApply.disabled = false;
      root.querySelector('#up-ytdlp').disabled = false;
      if (final.phase === 'restarting') {
        waitBackAndReload();
      } else if (final.status === 'error') {
        upNote.textContent = 'Update failed — see the log above.';
        toastErr('Update failed');
      } else {
        upNote.textContent = 'Done.';
      }
    } catch (e) {
      upApply.disabled = false;
      root.querySelector('#up-ytdlp').disabled = false;
      toastErr(e.detail || e.message || 'Update failed');
    }
  };

  root.querySelector('#up-apply').onclick = () => runUpdate('full');
  root.querySelector('#up-ytdlp').onclick = () => runUpdate('ytdlp');
  root.querySelector('#up-check').onclick = async () => {
    upBadge.innerHTML = `<span style="display:inline-flex" class="spin">${icon('spinner', 13)}</span> checking…`;
    try {
      const data = await api.updateCheck();
      if (data.update_available) {
        upBadge.textContent = `⬆ ${data.latest_tag} available`;
        upBadge.style.color = 'hsl(140 70% 55%)';
        upNote.classList.remove('hidden');
        upNote.textContent = `${data.reason || ''} — current v${data.current_version}` +
          (data.current_commit ? ` (${data.current_commit})` : '') +
          `, latest ${data.latest_tag}` +
          (data.remote_commit ? ` (build ${data.remote_commit})` : '') + '.';
        upApply.classList.remove('hidden');
      } else {
        upBadge.textContent = '✓ up to date';
        upBadge.style.color = 'hsl(140 70% 55%)';
        upNote.classList.remove('hidden');
        upNote.textContent = `You're on the latest release (${data.latest_tag}).`;
        upApply.classList.add('hidden');
      }
    } catch (e) {
      upBadge.textContent = '✗ check failed';
      upNote.classList.remove('hidden');
      upNote.textContent = e.detail || e.message || 'Check failed';
    }
  };

  return {};
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
