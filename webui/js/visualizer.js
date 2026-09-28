// Audio visualizer for the now-playing overlay — mirrored frequency bars
// driven by the EQ graph's AnalyserNode. When Web Audio isn't available
// (or the context refuses to start) it falls back to a gentle simulated
// pulse so the overlay never breaks.

import { get, set } from './store.js';
import { getAnalyser } from './eq.js';

const BARS = 48;

let canvas = null;
let ctx2d = null;
let raf = null;
let mode = 'bars';          // 'bars' | 'wave'
let analyser = null;
let freqData = null;
let levels = new Array(BARS).fill(0);
let t0 = performance.now();
let hiddenFrames = 0;

export function initVisualizer() {
  const btn = document.getElementById('np-viz');
  if (!btn) return;
  btn.onclick = toggleViz;
  // the canvas only exists inside the now-playing overlay — follow it open/closed
  const ov = document.getElementById('np-overlay');
  if (ov) {
    const mo = new MutationObserver(() => {
      const openNow = !ov.classList.contains('hidden');
      if (openNow && get('vizOn') && get('current') && !raf) startViz();
      if (!openNow && raf) stopViz();
    });
    mo.observe(ov, { attributes: true, attributeFilter: ['class'] });
  }
}

export function vizActive() { return !!raf; }

export function toggleViz() {
  if (raf) stopViz();
  else startViz();
}

export function startViz() {
  const btn = document.getElementById('np-viz');
  canvas = document.getElementById('np-viz-canvas');
  if (!canvas || !get('current')) return;
  canvas.classList.remove('hidden');
  if (btn) btn.classList.add('on');
  analyser = getAnalyser();
  if (analyser) {
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(200, canvas.clientWidth * dpr);
  canvas.height = Math.max(60, canvas.clientHeight * dpr);
  ctx2d = canvas.getContext('2d');
  set({ vizOn: true }, false);
  if (!raf) raf = requestAnimationFrame(draw);
}

export function stopViz() {
  const btn = document.getElementById('np-viz');
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (canvas) canvas.classList.add('hidden');
  if (btn) btn.classList.remove('on');
  set({ vizOn: false }, false);
}

function draw() {
  raf = requestAnimationFrame(draw);
  if (!ctx2d || !canvas) return;
  // the now-playing overlay closed — stop burning frames
  if (!canvas.isConnected || canvas.offsetParent === null) {
    if (++hiddenFrames > 90) { stopViz(); return; }
  } else {
    hiddenFrames = 0;
  }
  const W = canvas.width, H = canvas.height;
  const playing = !!get('playing');
  ctx2d.clearRect(0, 0, W, H);

  const hue = Number(getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-h')) || 178;
  const grad = ctx2d.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, `hsl(${hue} 85% 55%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360} 85% 62%)`);

  const target = sampleLevels(playing);
  // ease toward the target so pauses decay smoothly instead of snapping
  for (let i = 0; i < BARS; i++) {
    levels[i] += (target[i] - levels[i]) * (playing ? 0.38 : 0.12);
  }

  if (mode === 'bars') {
    const gap = W / BARS * 0.24;
    const bw = (W - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const v = Math.max(0.02, levels[i]);
      const h = v * H * 0.92;
      const x = i * (bw + gap);
      const y = (H - h) / 2;
      const r = Math.min(bw / 2, 3);
      ctx2d.fillStyle = grad;
      ctx2d.globalAlpha = 0.35 + v * 0.65;
      roundRect(ctx2d, x, y, bw, h, r);
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
  } else {
    ctx2d.strokeStyle = grad;
    ctx2d.lineWidth = 2.2;
    ctx2d.beginPath();
    for (let i = 0; i < BARS; i++) {
      const x = (i / (BARS - 1)) * W;
      const y = H / 2 + (levels[i] - 0.5) * H * 0.8 * (i % 2 ? 1 : -1);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
}

function sampleLevels(playing) {
  const out = new Array(BARS);
  if (analyser && playing) {
    analyser.getByteFrequencyData(freqData);
    // log-ish bucketing: low frequencies own more pixels, highs compress
    const n = freqData.length;
    for (let i = 0; i < BARS; i++) {
      const lo = Math.floor(Math.pow(i / BARS, 1.6) * n);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / BARS, 1.6) * n));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += freqData[j];
      out[i] = Math.min(1, (sum / (hi - lo)) / 210);
    }
    return out;
  }
  // simulated: layered sines — lively while playing, settling to ripples
  const t = (performance.now() - t0) / 1000;
  const amp = playing ? 0.55 : 0.10;
  for (let i = 0; i < BARS; i++) {
    const p = i / BARS;
    out[i] = playing
      ? amp * (0.4 + 0.6 * Math.abs(Math.sin(t * 2.1 + p * 9.3)) *
               (1 - p * 0.55) + 0.18 * Math.sin(t * 7.7 + p * 23))
      : 0.06 + 0.05 * Math.abs(Math.sin(t * 1.2 + p * 6));
  }
  return out;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
