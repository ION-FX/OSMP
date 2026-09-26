// Settings — appearance, AI curator, security, playback, server info.

import { api, fmtBytes } from '../api.js';
import { get, set, load, persist } from '../store.js';
import { icon } from '../components/icons.js';
import { toast, toastOk, toastErr } from '../components/toast.js';
import { THEMES, ACCENTS, applyTheme, applyAccent, applyMotion } from '../theme.js';
import { refreshPlaylistsDeep } from '../actions.js';

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
      <div class="section-head-row"><h2>${icon('server', 19)} &nbsp;Playback & server</h2></div>
      <div class="card" style="cursor:default">
        <div class="field" style="margin-bottom:16px">
          <label>Stream format</label>
          <select class="select" id="st-format" style="max-width:320px">
            <option value="auto">Auto (m4a, opus fallback) — most compatible</option>
            <option value="m4a">m4a / AAC — works everywhere incl. Safari</option>
            <option value="opus">Opus / WebM — best quality, Chromium browsers</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:16px">
          <label>Access PIN <span class="faint">(optional — locks the web UI & API)</span></label>
          <div class="row gap-m" style="max-width:420px">
            <input class="input" id="st-pin" type="password" placeholder="${serverSettings.access_pin ? '•••• (set)' : 'No PIN set'}" maxlength="32">
            <button class="btn ghost" id="st-pin-save">Set</button>
            ${serverSettings.access_pin ? '<button class="btn danger" id="st-pin-clear">Clear</button>' : ''}
          </div>
          <div class="hint">Changing the PIN signs out all sessions.</div>
        </div>
        <div id="st-server-info" class="dim" style="font-size:13px;line-height:1.9"></div>
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

  root.querySelector('#st-pin-save').onclick = async () => {
    const pin = root.querySelector('#st-pin').value.trim();
    if (!pin) { toast('Enter a PIN first'); return; }
    try {
      await api.saveSettings({ access_pin: pin });
      root.querySelector('#st-pin').value = '';
      toastOk('PIN set — the UI will ask for it on fresh sessions');
    } catch (e) { toastErr('Failed to set PIN'); }
  };
  root.querySelector('#st-pin-clear')?.addEventListener('click', async () => {
    try {
      await api.saveSettings({ access_pin: '' });
      toastOk('PIN removed');
      setTimeout(() => location.reload(), 800);
    } catch (e) { toastErr('Failed'); }
  });

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

  return {};
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
