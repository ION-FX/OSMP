// OSMP theme engine — theme mode, accent hue, ambient color extraction
// from cover art (canvas), all persisted.

import { load, persist, set, get } from './store.js';

export const THEMES = [
  { id: 'dark', label: 'Aurora Dark', icon: 'moon' },
  { id: 'midnight', label: 'Midnight', icon: 'disc' },
  { id: 'light', label: 'Daylight', icon: 'sun' },
];

export const ACCENTS = [
  { h: 178, name: 'Teal' },
  { h: 265, name: 'Violet' },
  { h: 215, name: 'Blue' },
  { h: 340, name: 'Rose' },
  { h: 4, name: 'Red' },
  { h: 26, name: 'Ember' },
  { h: 46, name: 'Gold' },
  { h: 96, name: 'Lime' },
];

const html = document.documentElement;

export function applyTheme(themeId) {
  html.dataset.theme = THEMES.some(t => t.id === themeId) ? themeId : 'dark';
  persist('theme', html.dataset.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = html.dataset.theme === 'light' ? '#f2f5f9'
      : html.dataset.theme === 'midnight' ? '#000000' : '#0a0e14';
  }
}

export function applyAccent(hue) {
  const h = Number(hue);
  if (!Number.isFinite(h)) return;
  html.style.setProperty('--accent-h', String(((h % 360) + 360) % 360));
  persist('accent', h);
}

export function applyMotion(on) {
  html.dataset.motion = on ? 'on' : 'off';
  persist('motion', on);
}

export function initTheme() {
  applyTheme(load('theme', 'dark'));
  applyAccent(load('accent', 178));
  applyMotion(load('motion', true));
  autoLowSpec();
}

/* Weak hardware (phones, old laptops): freeze the ambient drift and strip
   glass blurs automatically — unless the user picked a preference explicitly. */
function autoLowSpec() {
  if (localStorage.getItem('osmp.motion') !== null) return; // explicit user choice wins
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  if (cores <= 4 || mem <= 4) {
    document.documentElement.dataset.perf = 'low';
  }
}

// ── ambient color extraction ─────────────────────────────────────────
// Draws the cover on a tiny canvas, quantizes pixels into hue buckets,
// returns the two dominant hues. CORS-safe: i.ytimg.com serves ACAO:*.

const _canvas = document.createElement('canvas');
_canvas.width = 48; _canvas.height = 48;
const _ctx = _canvas.getContext('2d', { willReadFrequently: true });
const _imgCache = new Map(); // src -> {h1,h2}

export function dominantHues(src) {
  if (!src) return Promise.resolve(null);
  if (_imgCache.has(src)) return Promise.resolve(_imgCache.get(src));
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        _ctx.drawImage(img, 0, 0, 48, 48);
        const { data } = _ctx.getImageData(0, 0, 48, 48);
        const res = quantize(data);
        _imgCache.set(src, res);
        if (_imgCache.size > 120) _imgCache.delete(_imgCache.keys().next().value);
        resolve(res);
      } catch {
        resolve(null); // tainted canvas or decode failure
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function quantize(data) {
  const buckets = new Map(); // hue -> {weight, sat, light}
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d < 0.08 || l < 0.12 || l > 0.93) continue; // skip grays/near-black/white
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    h = ((h % 360) + 360) % 360;
    const key = Math.round(h / 12) * 12; // 12° buckets
    const w = s * (1 - Math.abs(l - 0.5) * 0.7); // vivid mid-tones win
    const cur = buckets.get(key) || { weight: 0 };
    cur.weight += w;
    buckets.set(key, cur);
    total += w;
  }
  if (!total) return null;
  const ranked = [...buckets.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const h1 = ranked[0][0];
  // second hue: furthest-weighted bucket distinct from h1
  let h2 = null, best = 0;
  for (const [h, v] of ranked.slice(1, 8)) {
    const dist = Math.min(Math.abs(h - h1), 360 - Math.abs(h - h1));
    const score = v.weight * (dist / 180);
    if (score > best) { best = score; h2 = h; }
  }
  if (h2 === null) h2 = (h1 + 82) % 360;
  return { h1, h2 };
}

let _ambToken = 0;
export async function setAmbientFromCover(src) {
  const token = ++_ambToken;
  const hues = await dominantHues(src);
  if (token !== _ambToken) return; // a newer track took over
  const h1 = hues ? hues.h1 : null;
  const h2 = hues ? hues.h2 : null;
  set({ ambient: { h1, h2 } });
  applyAmbientCss(h1, h2);
}

export function applyAmbientCss(h1, h2) {
  const root = document.documentElement;
  if (h1 !== null) {
    root.style.setProperty('--amb-h', String(h1));
    root.style.setProperty('--amb-h2', String(h2 ?? (h1 + 82) % 360));
    root.style.setProperty('--amb-a', html.dataset.theme === 'light' ? '0.12' : '0.2');
  } else {
    root.style.removeProperty('--amb-h');
    root.style.removeProperty('--amb-h2');
    root.style.removeProperty('--amb-a');
  }
}

export function currentAccentHue() {
  return Number(getComputedStyle(html).getPropertyValue('--accent-h')) || 178;
}
