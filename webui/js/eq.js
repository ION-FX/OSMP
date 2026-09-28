// Equalizer — a Web Audio 3-band EQ over the single <audio> element.
//
// The graph (source → bass → mid → treble → destination) is built lazily on
// the first user interaction with a slider or preset chip: browsers only let
// an AudioContext start from a gesture, and a MediaElementSource can only
// ever be created once per element, so it must not happen at boot. Once the
// graph exists all playback flows through it; "off" is just all gains at 0.

import { load, persist } from './store.js';

export const BANDS = [
  { id: 'bass', label: 'Bass', freq: 180, type: 'lowshelf', unit: 'dB' },
  { id: 'mid', label: 'Mid', freq: 1400, type: 'peaking', q: 0.9, unit: 'dB' },
  { id: 'treble', label: 'Treble', freq: 5200, type: 'highshelf', unit: 'dB' },
];

export const PRESETS = {
  Flat: { bass: 0, mid: 0, treble: 0 },
  'Bass Boost': { bass: 6.5, mid: 0, treble: 1 },
  Vocal: { bass: -2, mid: 4.5, treble: 2 },
  Rock: { bass: 4, mid: -1, treble: 3.5 },
  Electronic: { bass: 6, mid: 1.5, treble: 4 },
  Acoustic: { bass: 2.5, mid: 3, treble: 2 },
  'Late Night': { bass: 3, mid: -1.5, treble: -2 },
};

const RANGE = 12; // ± dB

let ctx = null;
let filters = [];
let analyser = null;  // shared tap for the visualizer
let bypassed = false; // master switch: zero all gains without losing them
let gains = null;     // { bass, mid, treble } in dB
let presetName = 'Flat';

function state() {
  if (!gains) {
    const saved = load('eq', null);
    if (saved && saved.gains) {
      gains = { ...saved.gains };
      presetName = saved.preset || matchPreset();
    } else {
      gains = { ...PRESETS.Flat };
      presetName = 'Flat';
    }
    bypassed = !!load('eqBypass', false);
  }
  return gains;
}

function matchPreset() {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (BANDS.every(b => Math.abs((p[b.id] || 0) - (gains[b.id] || 0)) < 0.01)) {
      return name;
    }
  }
  return 'Custom';
}

function save() {
  persist('eq', { preset: presetName, gains: { ...gains } });
}

function attach() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  const a = document.getElementById('audio-el');
  if (!AC || !a) return false;
  try {
    ctx = new AC();
    const src = ctx.createMediaElementSource(a);
    state();
    filters = BANDS.map(b => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.q) f.Q.value = b.q;
      f.gain.value = gains[b.id] || 0;
      return f;
    });
    let node = src;
    filters.forEach(f => { node.connect(f); node = f; });
    node.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  } catch (e) {
    console.warn('[eq] audio graph failed', e);
    ctx = null;
    return false;
  }
}

function apply() {
  if (!attach()) return;  // no gesture yet / unsupported — values apply later
  filters.forEach((f, i) => {
    const v = bypassed ? 0 : (gains[BANDS[i].id] || 0);
    f.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  });
}

/** Master bypass — zeroes the bands but keeps the preset/sliders intact. */
export function toggleBypass(force) {
  bypassed = force !== undefined ? force : !bypassed;
  persist('eqBypass', bypassed);
  apply();
  return bypassed;
}

export function isBypassed() {
  return bypassed;
}

/** Called by the player on each 'playing' event: a suspended context means
 *  total silence once the graph exists, so nudge it awake. */
export function ensureRunning() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/** Frequency analyser tapped off the EQ chain (creates the graph if this is
 *  the first user gesture). Analyser taps don't reroute audio, so this is
 *  safe to call even when every EQ gain is zero. */
export function getAnalyser() {
  if (!attach()) return null;
  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    filters[filters.length - 1].connect(analyser);
  }
  ensureRunning();
  return analyser;
}

export function getEq() {
  state();
  return {
    bands: BANDS.map(b => ({ ...b, db: gains[b.id] || 0 })),
    preset: presetName,
    range: RANGE,
    attached: !!ctx,
    supported: !!(window.AudioContext || window.webkitAudioContext),
  };
}

export function setBand(id, db) {
  state();
  if (!(id in gains)) return;
  gains[id] = Math.max(-RANGE, Math.min(RANGE, db));
  presetName = matchPreset();
  save();
  apply();
}

export function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return false;
  state();
  gains = { ...p };
  presetName = name;
  save();
  apply();
  return true;
}

export function resetEq() {
  applyPreset('Flat');
}
