/* =========================================================
   大通道（CH1–CH4）路由核心
   每个功能模块是一条「大通道」：
   · 每通道独立 AnalyserNode → 主示波器绘制独立彩色波形
   · 每通道独立音量、开关
   · 路由：合并(MIX) → 汇入合并总线；独立(SOLO) → 汇入独立总线
     （任一通道独立时，只监听独立总线；否则输出合并总线）
   ========================================================= */
'use strict';

import { bus } from './bus.js';

export const CH_DEFS = [
  { id: 'ch1', code: 'CH1', name: '混音器',   color: '#3cff88', vol: 0.8 },
  { id: 'ch2', code: 'CH2', name: '时间线',   color: '#ffb454', vol: 0.8 },
  { id: 'ch3', code: 'CH3', name: '本地音乐', color: '#57c8ff', vol: 0.8 },
  { id: 'ch4', code: 'CH4', name: '音序器',   color: '#ff7bd5', vol: 0.8 }
];

export const chState = {};
for (const d of CH_DEFS) chState[d.id] = { on: true, route: 'mix', vol: d.vol };

let ctx = null;
const chAnalysers = {};
const chGains = {};
const chToMix = {};
const chToSolo = {};
const chTimeData = {};
const chFreqData = {};
let mixBus = null;
let soloBus = null;
let mixSel = null;
let soloSel = null;

/** 由引擎 ensureCtx 调用：建立路由总线与每通道节点（destNode = 总输出 Gain） */
export function initChannelRouting(audioCtx, destNode) {
  if (ctx) return;
  ctx = audioCtx;
  mixBus = ctx.createGain();
  soloBus = ctx.createGain();
  mixSel = ctx.createGain();
  soloSel = ctx.createGain();
  const masterBus = ctx.createGain();
  mixBus.connect(mixSel);
  mixSel.connect(masterBus);
  soloBus.connect(soloSel);
  soloSel.connect(masterBus);
  masterBus.connect(destNode);

  for (const d of CH_DEFS) {
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    const tm = ctx.createGain();
    tm.gain.value = 0;
    const ts = ctx.createGain();
    ts.gain.value = 0;
    an.connect(g);
    g.connect(tm);
    g.connect(ts);
    tm.connect(mixBus);
    ts.connect(soloBus);
    chAnalysers[d.id] = an;
    chGains[d.id] = g;
    chToMix[d.id] = tm;
    chToSolo[d.id] = ts;
    chTimeData[d.id] = new Float32Array(an.fftSize);
    chFreqData[d.id] = new Uint8Array(an.frequencyBinCount);
  }
  applyRouting();
}

export function isRoutingReady() { return !!ctx; }

/** 把某通道的音频源接入路由（源 → 通道 Analyser → 音量 → 总线） */
export function connectChannelSource(id, node) {
  const an = chAnalysers[id];
  if (an && node) {
    try { node.connect(an); } catch (err) { /* 已连接等异常可忽略 */ }
  }
}

export function getChannelAnalyser(id) { return chAnalysers[id] || null; }
export function getChannelTimeData(id) { return chTimeData[id] || null; }
export function getChannelFreqData(id) { return chFreqData[id] || null; }
export function readChannelTimeData(id) {
  const an = chAnalysers[id];
  if (an && chTimeData[id]) an.getFloatTimeDomainData(chTimeData[id]);
}
export function readChannelFreqData(id) {
  const an = chAnalysers[id];
  if (an && chFreqData[id]) an.getByteFrequencyData(chFreqData[id]);
}

export function anySolo() {
  for (const d of CH_DEFS) {
    const s = chState[d.id];
    if (s.on && s.route === 'solo') return true;
  }
  return false;
}

function setGain(node, v) {
  if (!node) return;
  if (ctx) node.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
  else node.gain.value = v;
}

/** 依据通道状态刷新全部增益路由 */
export function applyRouting() {
  const solo = anySolo();
  for (const d of CH_DEFS) {
    const s = chState[d.id];
    setGain(chGains[d.id], s.on ? s.vol : 0);
    setGain(chToMix[d.id], s.on && s.route === 'mix' ? 1 : 0);
    setGain(chToSolo[d.id], s.on && s.route === 'solo' ? 1 : 0);
  }
  setGain(mixSel, solo ? 0 : 1);
  setGain(soloSel, solo ? 1 : 0);
}

export function setChannelOn(id, on) {
  const s = chState[id];
  if (!s) return;
  s.on = !!on;
  applyRouting();
  bus.emit('channels-changed');
}

export function setChannelRoute(id, route) {
  const s = chState[id];
  if (!s) return;
  s.route = route === 'solo' ? 'solo' : 'mix';
  applyRouting();
  bus.emit('channels-changed');
}

export function cycleChannelRoute(id) {
  const s = chState[id];
  if (!s) return;
  s.route = s.route === 'mix' ? 'solo' : 'mix';
  applyRouting();
  bus.emit('channels-changed');
}

export function setChannelVol(id, vol) {
  const s = chState[id];
  if (!s) return;
  s.vol = Math.max(0, Math.min(1, vol));
  applyRouting();
  bus.emit('channels-changed');
}
