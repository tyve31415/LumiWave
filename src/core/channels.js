/* =========================================================
   大通道（CH1–CH4）路由核心
   · 4 个输出通道；每个通道 = 所选音源之和
     （音源：混音器 / 时间线 / 音乐播放器 / 音序器，可多选相加）
   · 每通道独立 AnalyserNode → 主示波器 4 通道分栏波形
   · 每通道独立音量、开关
   · 路由：合并(MIX) → 汇入合并总线；独立(SOLO) → 汇入独立总线
     （任一通道独立时，只监听独立总线；否则输出合并总线）
   · 通道配置（开关/路由/音量/音源组合）持久化到 localStorage
   ========================================================= */
'use strict';

import { bus } from './bus.js';

/** 可选音源（可被任意通道勾选，多个勾选则相加） */
export const SOURCES = [
  { id: 'mixer',    name: '混音器' },
  { id: 'timeline', name: '时间线' },
  { id: 'music',    name: '音乐播放器' },
  { id: 'seq',      name: '音序器' }
];

export const CH_DEFS = [
  { id: 'ch1', code: 'CH1', name: '混音器',   color: '#3cff88', vol: 0.8, srcId: 'mixer' },
  { id: 'ch2', code: 'CH2', name: '时间线',   color: '#ffb454', vol: 0.8, srcId: 'timeline' },
  { id: 'ch3', code: 'CH3', name: '本地音乐', color: '#57c8ff', vol: 0.8, srcId: 'music' },
  { id: 'ch4', code: 'CH4', name: '音序器',   color: '#ff7bd5', vol: 0.8, srcId: 'seq' }
];

const CH_SAVE_KEY = 'musicChannels';

function defaultSources(srcId) {
  const o = {};
  for (const s of SOURCES) o[s.id] = s.id === srcId;
  return o;
}

export const chState = {};
for (const d of CH_DEFS) {
  chState[d.id] = { on: true, route: 'mix', vol: d.vol, sources: defaultSources(d.srcId) };
}

/* ---------- 恢复持久化的通道配置 ---------- */
try {
  const raw = JSON.parse(localStorage.getItem(CH_SAVE_KEY) || '{}');
  if (raw && typeof raw === 'object') {
    for (const d of CH_DEFS) {
      const s = raw[d.id];
      if (!s || typeof s !== 'object') continue;
      const st = chState[d.id];
      if (typeof s.on === 'boolean') st.on = s.on;
      if (s.route === 'mix' || s.route === 'solo') st.route = s.route;
      if (typeof s.vol === 'number') st.vol = Math.max(0, Math.min(1, s.vol));
      if (s.sources && typeof s.sources === 'object') {
        for (const src of SOURCES) {
          if (typeof s.sources[src.id] === 'boolean') st.sources[src.id] = s.sources[src.id];
        }
      }
    }
  }
} catch (err) { /* 忽略损坏的配置 */ }

function persistChannels() {
  try { localStorage.setItem(CH_SAVE_KEY, JSON.stringify(chState)); } catch (err) { /* 忽略 */ }
}

let ctx = null;
const chSums = {};        // chId -> 求和节点（音源分支汇入点）
const chAnalysers = {};
const chGains = {};
const chToMix = {};
const chToSolo = {};
const srcTaps = {};       // srcTaps[srcId][chId] = GainNode（音源 → 通道求和）
const srcNodes = {};      // srcId -> 已接入的源节点（供路由重建时重接）
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
    const sum = ctx.createGain();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    const tm = ctx.createGain();
    tm.gain.value = 0;
    const ts = ctx.createGain();
    ts.gain.value = 0;
    sum.connect(an);
    an.connect(g);
    g.connect(tm);
    g.connect(ts);
    tm.connect(mixBus);
    ts.connect(soloBus);
    chSums[d.id] = sum;
    chAnalysers[d.id] = an;
    chGains[d.id] = g;
    chToMix[d.id] = tm;
    chToSolo[d.id] = ts;
    chTimeData[d.id] = new Float32Array(an.fftSize);
    chFreqData[d.id] = new Uint8Array(an.frequencyBinCount);
  }
  // 音源 → 各通道求和的分支（每个 (音源, 通道) 一个增益，勾选时打开）
  for (const src of SOURCES) {
    srcTaps[src.id] = {};
    for (const d of CH_DEFS) {
      const tap = ctx.createGain();
      tap.gain.value = 0;
      tap.connect(chSums[d.id]);
      srcTaps[src.id][d.id] = tap;
    }
  }
  // 若已有音源先于路由接入，重接一次
  for (const srcId in srcNodes) connectSourceNode(srcId, srcNodes[srcId]);
  applyRouting();
}

export function isRoutingReady() { return !!ctx; }

function connectSourceNode(srcId, node) {
  const taps = srcTaps[srcId];
  if (!taps || !node) return;
  for (const d of CH_DEFS) {
    try { node.connect(taps[d.id]); } catch (err) { /* 已连接等异常可忽略 */ }
  }
}

/** 注册某音源的输出节点，并接入所有通道的分支 */
export function connectSource(srcId, node) {
  srcNodes[srcId] = node;
  connectSourceNode(srcId, node);
}

/** 兼容旧调用：按通道的默认音源接入（引擎/播放器无需改动） */
export function connectChannelSource(id, node) {
  for (const d of CH_DEFS) {
    if (d.id === id) { connectSource(d.srcId, node); return; }
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

/** 依据通道状态刷新全部增益路由（含音源勾选分支） */
export function applyRouting() {
  const solo = anySolo();
  for (const d of CH_DEFS) {
    const s = chState[d.id];
    setGain(chGains[d.id], s.on ? s.vol : 0);
    setGain(chToMix[d.id], s.on && s.route === 'mix' ? 1 : 0);
    setGain(chToSolo[d.id], s.on && s.route === 'solo' ? 1 : 0);
    for (const src of SOURCES) {
      const tap = srcTaps[src.id] && srcTaps[src.id][d.id];
      if (tap) setGain(tap, s.sources[src.id] ? 1 : 0);
    }
  }
  setGain(mixSel, solo ? 0 : 1);
  setGain(soloSel, solo ? 1 : 0);
}

export function setChannelOn(id, on) {
  const s = chState[id];
  if (!s) return;
  s.on = !!on;
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

export function setChannelRoute(id, route) {
  const s = chState[id];
  if (!s) return;
  s.route = route === 'solo' ? 'solo' : 'mix';
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

export function cycleChannelRoute(id) {
  const s = chState[id];
  if (!s) return;
  s.route = s.route === 'mix' ? 'solo' : 'mix';
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

export function setChannelVol(id, vol) {
  const s = chState[id];
  if (!s) return;
  s.vol = Math.max(0, Math.min(1, vol));
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

/** 勾选/取消某通道的某个音源（该通道输出 = 所选音源之和） */
export function setChannelSource(id, srcId, on) {
  const s = chState[id];
  if (!s || !s.sources || !(srcId in s.sources)) return;
  s.sources[srcId] = !!on;
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

export function setChannelSources(id, map) {
  const s = chState[id];
  if (!s) return;
  for (const src of SOURCES) {
    if (typeof map[src.id] === 'boolean') s.sources[src.id] = map[src.id];
  }
  applyRouting();
  persistChannels();
  bus.emit('channels-changed');
}

/** 通道音源组合摘要（UI 显示用） */
export function channelSourceSummary(id) {
  const s = chState[id];
  if (!s) return '';
  const names = SOURCES.filter(function (src) { return s.sources[src.id]; })
    .map(function (src) { return src.name; });
  return names.length ? names.join(' + ') : '无输入';
}
