/* =========================================================
   主示波器：4 通道示波器（交互式通道选择）
   · 默认视图：CH1–CH4 各占一栏的独立彩色波形/频谱
   · 顶部 MIX 按钮：切换为「单个 MIX 通道」视图——
     混合输出波形/频谱占满整个示波器（单窗口显示）
   · 单击某通道栏 → 该栏边框高亮选中；再次单击同一栏 → 取消选中，
     边框恢复正常；右侧旋钮（垂直/水平/频幅/中心/带宽）调节选中
     通道（或 MIX）的波形与频谱参数
   · 每个通道与 MIX 各自持有独立的一套参数
   性能优化：
   1. 网格静态层缓存到离屏画布，仅尺寸变化时重绘
   2. 波形辉光用「双描边」替代 shadowBlur（显著降低 GPU 开销）
   3. 画布尺寸跟随窗口（ResizeObserver）
   ========================================================= */
'use strict';

import { el, sctx } from '../core/dom.js';
import { analyser, spectrumAnalyser, ctx, timeData, freqData, mainEngine } from '../core/engine.js';
import { CH_DEFS, chState, getChannelTimeData, readChannelTimeData, getChannelFreqData, readChannelFreqData } from '../core/channels.js';
import { SONG_BPM } from '../core/song.js';
import { seqState } from './sequencer.js';
import { clamp, TWO_PI, PI, midiToFreq } from '../core/math.js';

const PARAM_DEFAULTS = {
  amp: 0.24,
  samples: 2048,
  specAmp: 1.0,
  specCenter: 632.0,
  specSpan: 20000.0
};

export const scopeState = {
  mode: 'wave',        // 'wave' | 'spectrum'
  view: 'channels',    // 'channels'（4 个独立通道分栏）| 'mix'（单个 MIX 通道全屏）
  selected: 'ch1',     // 当前高亮选中的目标（ch1–ch4 / mix / null=未选中），旋钮作用于它
  params: {},          // 每个通道与 mix 各自独立的示波器参数
  w: 0,
  h: 0
};
for (const k of ['ch1', 'ch2', 'ch3', 'ch4', 'mix']) {
  scopeState.params[k] = Object.assign({}, PARAM_DEFAULTS);
}

/** 旋钮参数目标：未选中时沿用最后选中的通道 */
let lastChTarget = 'ch1';

/** 当前旋钮读写目标（选中目标优先，取消选中时沿用最后通道） */
function curParams() {
  const key = scopeState.selected || lastChTarget;
  return scopeState.params[key] || scopeState.params.ch1;
}

/* ---------- 画布适配（供各模块复用） ---------- */
export function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.floor(w * dpr);
  cv.height = Math.floor(h * dpr);
  cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: w, h: h };
}

/* ---------- 网格静态层（离屏缓存） ---------- */
const gridLayer = document.createElement('canvas');

function renderGridLayer() {
  const dpr = window.devicePixelRatio || 1;
  gridLayer.width = Math.floor(scopeState.w * dpr);
  gridLayer.height = Math.floor(scopeState.h * dpr);
  const g = gridLayer.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, scopeState.w, scopeState.h);

  // 竖向细网格
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(60,255,136,0.07)';
  for (let i = 0; i <= 24; i++) {
    const x = (i / 24) * scopeState.w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, scopeState.h); g.stroke();
  }
  // 每栏横向细网格
  const lanes = scopeState.view === 'mix' ? 1 : 4;
  const laneH = scopeState.h / lanes;
  for (let i = 0; i <= 10; i++) {
    const y = (i / 10) * scopeState.h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(scopeState.w, y); g.stroke();
  }
  // 栏中线（每栏内）
  g.strokeStyle = 'rgba(60,255,136,0.10)';
  for (let lane = 0; lane < lanes; lane++) {
    const mid = lane * laneH + laneH / 2;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(scopeState.w, mid); g.stroke();
  }
  // 分栏分隔线（4 通道视图）；MIX 视图为单窗口，无分隔线
  g.strokeStyle = 'rgba(60,255,136,0.24)';
  for (let lane = 1; lane < lanes; lane++) {
    const y = lane * laneH;
    g.beginPath(); g.moveTo(0, y); g.lineTo(scopeState.w, y); g.stroke();
  }
  // MIX 单窗口视图：补一条垂直中线
  if (lanes === 1) {
    g.beginPath(); g.moveTo(scopeState.w / 2, 0); g.lineTo(scopeState.w / 2, scopeState.h); g.stroke();
  }
}

export function resizeScope() {
  const a = fitCanvas(el.scope);
  scopeState.w = a.w;
  scopeState.h = a.h;
  renderGridLayer();
}

/* ---------- 波形绘制 ---------- */
function tracePath(data, n, w, amp, mid) {
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = mid - data[i] * amp;
    if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  }
}

function laneAmp(laneH, p) {
  return laneH * clamp(p.amp * 2, 0.08, 2.6);
}

/** CH1–CH4：各占一栏的独立彩色波形（4 通道视图，参数按通道独立） */
function drawChannelLanes() {
  const w = scopeState.w, h = scopeState.h;
  const laneH = h / 4;
  for (let i = 0; i < CH_DEFS.length; i++) {
    const d = CH_DEFS[i];
    const s = chState[d.id];
    const p = scopeState.params[d.id];
    const y0 = i * laneH;
    const mid = y0 + laneH / 2;
    const amp = laneAmp(laneH, p);
    const n = Math.min(p.samples, 2048);
    // 栏标签（中性通道编号）
    sctx.save();
    sctx.font = '10px monospace';
    sctx.textBaseline = 'top';
    sctx.fillStyle = d.color;
    sctx.globalAlpha = s.on ? 0.95 : 0.32;
    sctx.fillText(d.code + (s.on ? '' : ' · 关'), 6, y0 + 3);
    sctx.restore();
    if (!s.on) continue;
    const td = getChannelTimeData(d.id);
    if (!td) continue;
    readChannelTimeData(d.id);
    sctx.save();
    sctx.strokeStyle = d.color;
    sctx.globalAlpha = 0.85;
    sctx.lineWidth = 1.15;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.beginPath();
    tracePath(td, n, w, amp, mid);
    sctx.stroke();
    sctx.restore();
  }
}

/** MIX 单窗口视图：混合输出波形占满整个示波器（亮绿双描边） */
function drawMixSingle() {
  if (!analyser) return;
  const p = scopeState.params.mix;
  const w = scopeState.w, h = scopeState.h;
  const mid = h / 2;
  const amp = h * p.amp;
  analyser.getFloatTimeDomainData(timeData);
  const n = Math.min(p.samples, timeData.length);
  const start = Math.floor((timeData.length - n) / 2);

  sctx.save();
  sctx.font = '10px monospace';
  sctx.textBaseline = 'top';
  sctx.fillStyle = '#eafff2';
  sctx.fillText('MIX 混合输出', 6, 6);
  sctx.lineCap = 'round';
  sctx.lineJoin = 'round';
  // 第一遍：宽、半透明（光晕）
  sctx.strokeStyle = 'rgba(77,255,154,0.28)';
  sctx.lineWidth = 4.5;
  sctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = mid - timeData[start + i] * amp;
    if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  }
  sctx.stroke();
  // 第二遍：细、实心
  sctx.strokeStyle = '#4dff9a';
  sctx.lineWidth = 1.7;
  sctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = mid - timeData[start + i] * amp;
    if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  }
  sctx.stroke();
  sctx.restore();
}

/** 选中目标边框高亮（4 通道视图=选中栏；MIX 视图=整个窗口；未选中不绘制） */
function drawSelectionBorder() {
  if (!scopeState.selected) return;
  const inMix = scopeState.view === 'mix';
  const idx = inMix ? -1 : CH_DEFS.findIndex(function (d) { return d.id === scopeState.selected; });
  const color = inMix ? '#eafff2' : (idx >= 0 ? CH_DEFS[idx].color : 'rgba(60,255,136,0.5)');
  const y0 = inMix || idx < 0 ? 2.5 : idx * (scopeState.h / 4) + 2.5;
  const bh = inMix || idx < 0 ? scopeState.h - 5 : scopeState.h / 4 - 5;
  sctx.save();
  sctx.lineJoin = 'round';
  // 第一遍：宽、半透明（光晕）
  sctx.strokeStyle = color;
  sctx.globalAlpha = 0.3;
  sctx.lineWidth = 5.5;
  sctx.strokeRect(2.5, y0, scopeState.w - 5, bh);
  // 第二遍：细、实心
  sctx.globalAlpha = 0.95;
  sctx.lineWidth = 1.6;
  sctx.strokeRect(2.5, y0, scopeState.w - 5, bh);
  sctx.restore();
}

function drawWave() {
  if (scopeState.view === 'mix') drawMixSingle();
  else drawChannelLanes();
  drawSelectionBorder();
}

/* ---------- 频谱绘制 ---------- */
function drawSpecBand(label, color, data, y0, bh, p) {
  const w = scopeState.w;
  sctx.save();
  sctx.fillStyle = color;
  const sr = ctx ? ctx.sampleRate : 44100;
  const binHz = sr / (2 * data.length);
  const fMin = Math.max(20, p.specCenter - p.specSpan / 2);
  const fMax = Math.max(fMin + 20, Math.min(sr / 2, p.specCenter + p.specSpan / 2));
  const NB = 160;
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);
  const n = data.length;
  const bw = w / NB;
  for (let k = 0; k < NB; k++) {
    const f0 = Math.exp(logMin + (logMax - logMin) * k / NB);
    const f1 = Math.exp(logMin + (logMax - logMin) * (k + 1) / NB);
    const i0 = Math.floor(f0 / binHz);
    const i1 = Math.min(n - 1, Math.ceil(f1 / binHz));
    let peak = 0;
    for (let i = i0; i <= i1; i++) {
      if (data[i] > peak) peak = data[i];
    }
    const v = peak / 255;
    const hh = Math.pow(v, 0.75) * bh * 0.92 * p.specAmp;
    sctx.globalAlpha = 0.9;
    sctx.fillRect(k * bw, y0 + bh - hh, Math.max(1, bw - 1), hh);
  }
  sctx.globalAlpha = 1;
  sctx.font = '10px monospace';
  sctx.textBaseline = 'top';
  sctx.fillText(label, 6, y0 + 3);
  sctx.restore();
}

function drawSpectrum() {
  if (!ctx) return;
  // MIX 单窗口视图：混合频谱占满整个示波器
  if (scopeState.view === 'mix') {
    if (spectrumAnalyser) {
      spectrumAnalyser.getByteFrequencyData(freqData);
      drawSpecBand('MIX 混合输出', '#eafff2', freqData, 0, scopeState.h, scopeState.params.mix);
    }
    drawSelectionBorder();
    return;
  }
  const laneH = scopeState.h / 4;
  for (let i = 0; i < CH_DEFS.length; i++) {
    const d = CH_DEFS[i];
    const s = chState[d.id];
    const y0 = i * laneH;
    const fd = getChannelFreqData(d.id);
    if (fd && s.on) {
      readChannelFreqData(d.id);
      drawSpecBand(d.code, d.color, fd, y0, laneH, scopeState.params[d.id]);
    } else {
      // 关闭通道：仅保留栏标签
      sctx.save();
      sctx.font = '10px monospace';
      sctx.textBaseline = 'top';
      sctx.fillStyle = d.color;
      sctx.globalAlpha = 0.32;
      sctx.fillText(d.code + ' · 关', 6, y0 + 3);
      sctx.restore();
    }
  }
  drawSelectionBorder();
}

/** 每帧调用（渲染循环已做空闲节流） */
export function drawScope() {
  if (!scopeState.w) return;
  sctx.fillStyle = 'rgba(2,7,4,0.24)';
  sctx.fillRect(0, 0, scopeState.w, scopeState.h);
  sctx.drawImage(gridLayer, 0, 0, scopeState.w, scopeState.h);
  if (analyser) {
    if (scopeState.mode === 'wave') drawWave();
    else drawSpectrum();
  }
}

export function toggleScopeMode() {
  scopeState.mode = scopeState.mode === 'wave' ? 'spectrum' : 'wave';
  el.viewToggle.textContent = scopeState.mode === 'wave' ? '波形' : '频谱';
}

/** 顶部 MIX 开关：在「4 个独立通道」与「单个 MIX 通道」两种显示之间切换 */
export function toggleMixView() {
  scopeState.view = scopeState.view === 'mix' ? 'channels' : 'mix';
  const inMix = scopeState.view === 'mix';
  scopeState.selected = inMix ? 'mix' : lastChTarget;
  el.mixToggle.textContent = inMix ? '4CH' : 'MIX';
  el.mixToggle.classList.toggle('on', inMix);
  el.mixToggle.title = inMix
    ? '切换回 4 个独立通道显示'
    : '切换为单个 MIX 混合通道显示';
  refreshKnobs();  // 旋钮指向新目标
  resizeScope();   // 视图变化 → 重算画布与网格
}

/** 单击通道栏：选中高亮；再次单击同一栏：取消选中（边框恢复正常） */
export function selectScopeTarget(id) {
  if (id === 'mix') {
    scopeState.selected = 'mix';
    refreshKnobs();
    return;
  }
  let isChannel = false;
  for (let i = 0; i < CH_DEFS.length; i++) {
    if (CH_DEFS[i].id === id) { isChannel = true; break; }
  }
  if (!isChannel) return;
  lastChTarget = id;
  scopeState.selected = scopeState.selected === id ? null : id;
  refreshKnobs();
}

/* ---------- 频率读数 ---------- */
function displayFreq() {
  if (mainEngine.heldOrder.length > 0) return midiToFreq(mainEngine.heldOrder[mainEngine.heldOrder.length - 1]);
  if (seqState.running) {
    const durMs = 60 / seqState.bpm / 4 * 1000;
    let i = Math.floor((performance.now() - seqState.startWall) / durMs);
    i = ((i % 16) + 16) % 16;
    const s = seqState.steps[i];
    if (s && s.on) return midiToFreq(s.midi);
  }
  return mainEngine.baseFreq;
}

export function updateFreqReadout() {
  el.freqReadout.textContent = mainEngine.songPlaying ? (SONG_BPM + ' BPM') : (displayFreq().toFixed(1) + ' Hz');
}

/* ---------- 旋钮（作用于当前选中通道/MIX 的参数） ---------- */
function sizeKnob(cv) {
  const dpr = window.devicePixelRatio || 1;
  const css = Math.max(20, cv.clientWidth || 28);
  cv.width = Math.floor(css * dpr);
  cv.height = Math.floor(css * dpr);
  cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawKnob(cv, v) {
  const c = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr, h = cv.height / dpr;
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 2;
  c.beginPath(); c.arc(cx, cy, r, 0, TWO_PI);
  c.strokeStyle = 'rgba(60,255,136,0.55)'; c.lineWidth = Math.max(1, r * 0.16); c.stroke();
  for (let i = 0; i <= 10; i++) {
    const a = (-135 + i * 27) * PI / 180;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * (r * 0.55), cy + Math.sin(a) * (r * 0.55));
    c.lineTo(cx + Math.cos(a) * (r * 0.85), cy + Math.sin(a) * (r * 0.85));
    c.strokeStyle = 'rgba(60,255,136,0.35)'; c.lineWidth = 1; c.stroke();
  }
  const pa = (-135 + v * 270) * PI / 180;
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(pa) * (r * 0.68), cy + Math.sin(pa) * (r * 0.68));
  c.strokeStyle = '#3cff88'; c.lineWidth = Math.max(1.5, r * 0.22);
  c.shadowColor = '#3cff88'; c.shadowBlur = 4;
  c.stroke();
  c.beginPath(); c.arc(cx, cy, Math.max(1.2, r * 0.16), 0, TWO_PI);
  c.fillStyle = '#3cff88'; c.fill();
}

const knobRefreshers = [];

function refreshKnobs() {
  for (let i = 0; i < knobRefreshers.length; i++) knobRefreshers[i]();
}

function bindKnob(cv, opts) {
  let dragging = false;
  let lastY = 0;
  function redraw() {
    const v = clamp(opts.get(), 0, 1);
    drawKnob(cv, v);
    opts.paint();
  }
  knobRefreshers.push(redraw);
  cv.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastY = e.clientY;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const dy = e.clientY - lastY;
    lastY = e.clientY;
    opts.set(clamp(opts.get() - dy * 0.005, 0, 1));
    redraw();
  });
  cv.addEventListener('pointerup', function () { dragging = false; });
  cv.addEventListener('pointercancel', function () { dragging = false; });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    opts.set(clamp(opts.get() - (e.deltaY > 0 ? 1 : -1) * 0.02, 0, 1));
    redraw();
  }, { passive: false });
  redraw();
}

function formatFreq(hz) {
  if (hz >= 1000) return (hz / 1000).toFixed(1) + ' kHz';
  return Math.round(hz) + ' Hz';
}

export function initScopeKnobs() {
  [el.knobVert, el.knobHoriz, el.knobSpecAmp, el.knobCenter, el.knobSpan].forEach(sizeKnob);

  bindKnob(el.knobVert, {
    get: function () { return Math.log(curParams().amp / 0.05) / Math.log(3.0 / 0.05); },
    set: function (v) { curParams().amp = Math.round(0.05 * Math.pow(3.0 / 0.05, v) * 100) / 100; },
    paint: function () { el.knobVertVal.textContent = curParams().amp.toFixed(2) + 'x'; }
  });
  bindKnob(el.knobHoriz, {
    get: function () { return Math.log(curParams().samples / 64) / Math.log(2048 / 64); },
    set: function (v) { curParams().samples = Math.max(64, Math.min(2048, Math.round(64 * Math.pow(2048 / 64, v)))); },
    paint: function () {
      const sr = window.SR || 44100;
      el.knobHorizVal.textContent = (curParams().samples / sr * 1000).toFixed(1) + ' ms';
    }
  });
  bindKnob(el.knobSpecAmp, {
    get: function () { return Math.log(curParams().specAmp / 0.2) / Math.log(3.0 / 0.2); },
    set: function (v) { curParams().specAmp = Math.round(0.2 * Math.pow(3.0 / 0.2, v) * 100) / 100; },
    paint: function () { el.knobSpecAmpVal.textContent = curParams().specAmp.toFixed(1) + 'x'; }
  });
  bindKnob(el.knobCenter, {
    get: function () { return Math.log(curParams().specCenter / 50) / Math.log(15000 / 50); },
    set: function (v) { curParams().specCenter = Math.round(50 * Math.pow(15000 / 50, v)); },
    paint: function () { el.knobCenterVal.textContent = formatFreq(curParams().specCenter); }
  });
  bindKnob(el.knobSpan, {
    get: function () { return Math.log(curParams().specSpan / 200) / Math.log(100000 / 200); },
    set: function (v) { curParams().specSpan = Math.round(200 * Math.pow(100000 / 200, v)); },
    paint: function () { el.knobSpanVal.textContent = formatFreq(curParams().specSpan); }
  });
}

export function initScope() {
  resizeScope();
  initScopeKnobs();
  el.viewToggle.addEventListener('click', toggleScopeMode);
  el.mixToggle.addEventListener('click', toggleMixView);
  // 单击通道栏：选中高亮；再次单击同一栏：取消选中（边框恢复正常）
  el.scope.addEventListener('pointerdown', function (e) {
    const rect = el.scope.getBoundingClientRect();
    if (!rect.height) return;
    const y = e.clientY - rect.top;
    if (scopeState.view === 'mix') {
      if (scopeState.selected !== 'mix') selectScopeTarget('mix');
      return;
    }
    const lane = Math.min(3, Math.max(0, Math.floor(y / (rect.height / 4))));
    selectScopeTarget(CH_DEFS[lane].id);
  });
  // 窗口大小/显示变化 → 重算画布与网格
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { resizeScope(); }).observe(el.scope);
  } else {
    window.addEventListener('resize', resizeScope);
  }
}
