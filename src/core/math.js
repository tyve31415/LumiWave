/* =========================================================
   数学与波形辅助函数（注入全局，供用户公式与兜底线程使用）
   ========================================================= */
'use strict';

export const TWO_PI = Math.PI * 2;
export const PI = Math.PI;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, x) { return a + (b - a) * x; }
export function sq(x) { return Math.sin(x) >= 0 ? 1 : -1; }
export function saw(x) { return 2 * (x / TWO_PI - Math.floor(x / TWO_PI)) - 1; }
export function tri(x) { return (2 / PI) * Math.asin(Math.sin(x)); }
export function pulse(x, w) { return Math.sin(x) >= (typeof w === 'number' ? w : 0) ? 1 : -1; }
export function noise() { return Math.random() * 2 - 1; }

export function noteFreq(name) {
  const m = /^([A-G])([#b]?)(-?[0-9]+)$/.exec(String(name).trim());
  if (!m) return 440;
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const semi = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}
export function n(name) { return noteFreq(name); }
export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function midiName(m) { const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']; return N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
export function seq(notes, t, dur) {
  if (!Array.isArray(notes) || notes.length === 0) return 440;
  let i = Math.floor(t / dur) % notes.length;
  if (i < 0) i += notes.length;
  return typeof notes[i] === 'number' ? notes[i] : noteFreq(notes[i]);
}

/** 注入到 window（主线程兜底路径的 new Function 依赖它） */
export function installGlobals(sampleRate) {
  window.PI = PI;
  window.TWO_PI = TWO_PI;
  window.SR = sampleRate || 44100;
  window.sin = Math.sin; window.cos = Math.cos; window.tan = Math.tan;
  window.atan = Math.atan; window.atan2 = Math.atan2;
  window.abs = Math.abs; window.floor = Math.floor; window.ceil = Math.ceil; window.round = Math.round;
  window.pow = Math.pow; window.sqrt = Math.sqrt; window.exp = Math.exp; window.log = Math.log; window.log2 = Math.log2;
  window.min = Math.min; window.max = Math.max; window.random = Math.random; window.sign = Math.sign;
  window.clamp = clamp; window.lerp = lerp;
  window.sq = sq; window.saw = saw; window.tri = tri; window.pulse = pulse; window.noise = noise;
  window.n = n; window.noteFreq = noteFreq; window.midiToFreq = midiToFreq; window.seq = seq;
}
