/* =========================================================
   DSP 核心：16 声部状态机、逐采样渲染、消息应用、Worklet 源码构建
   （同一份逻辑：AudioWorklet 线程与兜底 ScriptProcessor 线程共用）
   ========================================================= */
'use strict';

import { SONG_DATA, SONG_LEN, SONG_TPS, S, P, songSearch } from './song.js';
import {
  sq, saw, tri, pulse, noise,
  noteFreq, midiToFreq, seq, clamp, lerp
} from './math.js';

export const CHANNELS = 16;

/* ---------- 门限与音序步进（worklet 内独立运行） ---------- */
export function isGateOpen(state) {
  // seq-only：专用于「音序器」大通道——仅当音序运行且当前步打开时发声
  if (state.gateMode === 'seq-only') {
    if (!state.seq.running) return false;
    const s = seqStepAt(state);
    return !!(s && s.on);
  }
  if (state.held.length > 0) return true;
  if (state.seq.running) {
    const s = seqStepAt(state);
    return !!(s && s.on);
  }
  return true;
}

export function seqStepAt(state) {
  const dur = 60 / state.seq.bpm / 4;
  let i = Math.floor((state.t - state.seq.t0) / dur);
  i = ((i % 16) + 16) % 16;
  return state.seq.steps[i];
}

export function createState(opts) {
  opts = opts || {};
  const display = opts.collectDisplay ? [] : null;
  if (display) {
    for (let i = 0; i < CHANNELS; i++) display.push(new Float32Array(512));
  }
  return {
    voices: [],
    display: display,
    dispIdx: 0,
    gateMode: opts.gateMode || 'normal',
    // 每引擎独立的 S/P 函数前缀（多 worklet 共享全局作用域，需按前缀隔离）
    sPrefix: opts.sPrefix || '',
    // 兜底模式下的每引擎歌曲数据（worklet 模式由模块级变量承载）
    song: null,
    t: 0,
    env: 0,
    freq: 440,
    baseFreq: 440,
    attack: 0.005,
    release: 0.12,
    glide: 0,
    running: false,
    held: [],
    heldSet: {},
    seq: { running: false, bpm: 120, t0: 0, steps: [] },
    voiceErrors: []
  };
}

export function compileVoice(src) {
  return new Function('t', 'freq', 'env', 'return (' + src + ');');
}

export function processBlock(state, sr, L, R) {
  const dt = 1 / sr;
  const n = L.length;
  const vs = state.voices;
  const disp = state.display || null;
  const CAP = disp && disp.length ? disp[0].length : 0;
  let di = state.dispIdx || 0;
  if (disp && di === 0) { for (let v = 0; v < disp.length; v++) disp[v].fill(0); }
  for (let i = 0; i < n; i++) {
    let target = state.baseFreq;
    if (state.held.length > 0) {
      target = midiToFreq(state.held[state.held.length - 1]);
    } else if (state.seq.running) {
      const s = seqStepAt(state);
      if (s && s.on) target = midiToFreq(s.midi);
    }
    if (state.glide <= 0) {
      state.freq = target;
    } else {
      const c = 1 - Math.exp(-1 / ((state.glide * 10 / 1000) * sr));
      state.freq += (target - state.freq) * c;
      if (Math.abs(target - state.freq) < 0.001) state.freq = target;
    }
    const tEnv = isGateOpen(state) ? 1 : 0;
    if (state.env < tEnv) {
      const a = Math.max(state.attack, 0.0005);
      state.env = Math.min(1, state.env + 1 / (a * sr));
    } else if (state.env > tEnv) {
      const r = Math.max(state.release, 0.001);
      state.env = Math.max(0, state.env - 1 / (r * sr));
    }
    let s = 0;
    const cap = disp && di < CAP;
    if (state.running) {
      for (let v = 0; v < vs.length; v++) {
        const vo = vs[v];
        if (!vo.enabled) continue;
        if (vo.broken) { if (cap) disp[v][di] = 0; continue; }
        let val;
        try {
          val = vo.fn(state.t, state.freq, state.env);
        } catch (err) {
          vo.broken = true;
          if (state.voiceErrors.length < 8) {
            state.voiceErrors.push({ index: v, message: String((err && err.message) || err) });
          }
          if (cap) disp[v][di] = 0;
          continue;
        }
        if (typeof val !== 'number' || !isFinite(val)) val = 0;
        val *= vo.gain;
        if (cap) disp[v][di] = val;
        s += val;
      }
    }
    if (cap) di++;
    if (s > 1) s = 1; else if (s < -1) s = -1;
    L[i] = s;
    if (R !== L) R[i] = s;
    if (state.running) state.t += dt;
  }
  state.dispIdx = di;
}

export function applyMessage(state, m) {
  if (m.type === 'setVoices') {
    state.voices = m.voices.map(function (v) {
      let src = v.source;
      // 多引擎隔离：每个引擎的 S/P 函数带唯一前缀（worklet 全局作用域是共享的）
      if (state.sPrefix) {
        src = src.replace(/\bS\s*\(/g, state.sPrefix + 'S(').replace(/\bP\s*\(/g, state.sPrefix + 'P(');
      }
      return { fn: compileVoice(src), gain: v.gain, enabled: v.enabled, src: v.source };
    });
  } else if (m.type === 'voice') {
    const v = state.voices[m.index];
    if (v) { v.gain = m.gain; v.enabled = m.enabled; }
  } else if (m.type === 'song') {
    // 兜底（ScriptProcessor）模式：每引擎独立的歌曲数据
    if (state.song) { state.song.data = m.data; state.song.len = m.len; state.song.tps = m.tps; }
  } else if (m.type === 'params') {
    state.baseFreq = m.baseFreq;
    state.attack = m.attack;
    state.release = m.release;
    state.glide = m.glide;
  } else if (m.type === 'running') {
    state.running = m.on;
  } else if (m.type === 'resetTime') {
    state.t = 0;
    state.env = 0;
    state.held.length = 0;
    state.heldSet = {};
  } else if (m.type === 'noteOn') {
    if (!state.heldSet[m.midi]) { state.heldSet[m.midi] = true; state.held.push(m.midi); }
  } else if (m.type === 'noteOff') {
    if (state.heldSet[m.midi]) {
      delete state.heldSet[m.midi];
      const idx = state.held.indexOf(m.midi);
      if (idx >= 0) state.held.splice(idx, 1);
    }
  } else if (m.type === 'seq') {
    const s = state.seq;
    s.running = m.running;
    s.bpm = m.bpm;
    if (m.reset) s.t0 = state.t;
    s.steps = m.steps;
  }
}

/* ---------- AudioWorklet 处理器源码生成 ----------
   支持多实例：每个「大通道」引擎注册一个独立处理器。
   关键点：同一 AudioContext 的所有 worklet 共享一个全局作用域，
   因此歌曲数据 SONG_* 与 S/P 函数必须按引擎前缀隔离命名。 */
export function buildWorkletSource(processorName, opts) {
  opts = opts || {};
  const prefix = opts.sPrefix || 'main_';
  const pv = prefix.replace(/[^A-Za-z0-9_]/g, '_');
  const clsName = 'SynthProcessor_' + pv;
  const fns = {
    sq: sq, saw: saw, tri: tri, pulse: pulse, noise: noise,
    noteFreq: noteFreq, midiToFreq: midiToFreq, seq: seq, clamp: clamp, lerp: lerp, songSearch: songSearch,
    isGateOpen: isGateOpen, seqStepAt: seqStepAt,
    createState: createState, compileVoice: compileVoice,
    processBlock: processBlock, applyMessage: applyMessage
  };
  const names = Object.keys(fns);
  const lines = [];
  lines.push('var CHANNELS = ' + CHANNELS + ';');
  lines.push('var TWO_PI = Math.PI * 2, PI = Math.PI;');
  lines.push('var sin = Math.sin, cos = Math.cos, tan = Math.tan, atan = Math.atan, atan2 = Math.atan2, abs = Math.abs, floor = Math.floor, ceil = Math.ceil, round = Math.round, pow = Math.pow, sqrt = Math.sqrt, exp = Math.exp, log = Math.log, log2 = Math.log2, min = Math.min, max = Math.max, random = Math.random, sign = Math.sign;');
  for (let k = 0; k < names.length; k++) {
    lines.push('var ' + names[k] + ' = ' + fns[names[k]].toString() + ';');
  }
  lines.push('var n = function(name){ return noteFreq(name); };');
  // 每引擎独立的歌曲数据 + 带前缀的 S/P 函数
  lines.push('var SONG_DATA_' + pv + ' = ' + JSON.stringify(SONG_DATA) + ';');
  lines.push('var SONG_LEN_' + pv + ' = ' + SONG_LEN + ';');
  lines.push('var SONG_TPS_' + pv + ' = ' + SONG_TPS + ';');
  lines.push('var ' + pv + 'S = ' + S.toString()
    .replace(/\bSONG_DATA\b/g, 'SONG_DATA_' + pv)
    .replace(/\bSONG_LEN\b/g, 'SONG_LEN_' + pv)
    .replace(/\bSONG_TPS\b/g, 'SONG_TPS_' + pv) + ';');
  lines.push('var ' + pv + 'P = ' + P.toString()
    .replace(/\bSONG_DATA\b/g, 'SONG_DATA_' + pv)
    .replace(/\bSONG_LEN\b/g, 'SONG_LEN_' + pv)
    .replace(/\bSONG_TPS\b/g, 'SONG_TPS_' + pv) + ';');
  // 关键：声部函数由 new Function 编译，只能看到 globalThis——
  // 必须把带前缀的 S/P 显式挂到 globalThis，否则公式里的 S() 被改写为
  // ch1_S()/ch2_S()/ch4_S() 后会在运行时报 "xxx_S is not defined"
  lines.push('globalThis.' + pv + 'S = ' + pv + 'S; globalThis.' + pv + 'P = ' + pv + 'P;');
  lines.push('globalThis.TWO_PI = TWO_PI; globalThis.PI = PI; globalThis.SR = sampleRate;');
  lines.push('globalThis.sin = sin; globalThis.cos = cos; globalThis.tan = tan; globalThis.atan = atan; globalThis.atan2 = atan2; globalThis.abs = abs; globalThis.floor = floor; globalThis.ceil = ceil; globalThis.round = round; globalThis.pow = pow; globalThis.sqrt = sqrt; globalThis.exp = exp; globalThis.log = log; globalThis.log2 = log2; globalThis.min = min; globalThis.max = max; globalThis.random = random; globalThis.sign = sign;');
  for (let k = 0; k < names.length; k++) {
    lines.push('globalThis.' + names[k] + ' = ' + names[k] + ';');
  }
  lines.push('globalThis.n = n;');
  lines.push('globalThis.S = ' + pv + 'S; globalThis.P = ' + pv + 'P;');
  lines.push('var __opts = { collectDisplay: ' + !!opts.collectDisplay + ', gateMode: ' + JSON.stringify(opts.gateMode || 'normal') + ', sPrefix: ' + JSON.stringify(prefix) + ' };');
  lines.push('class ' + clsName + ' extends AudioWorkletProcessor {');
  lines.push('  constructor(){ super(); this.state = createState(__opts); var self = this; this.port.onmessage = function(e){ var m = e.data; if(m.type === "song"){ SONG_DATA_' + pv + ' = m.data; SONG_LEN_' + pv + ' = m.len; SONG_TPS_' + pv + ' = m.tps; } else if(m.type === "getVoices"){ var info = []; for(var k = 0; k < self.state.voices.length; k++){ info.push({ enabled: self.state.voices[k].enabled, gain: self.state.voices[k].gain, src: self.state.voices[k].src }); } self.port.postMessage({ type: "voicesInfo", data: info }); } else { try { applyMessage(self.state, m); } catch(err) { self.port.postMessage({ type: "workletError", message: String((err && err.message) || err) }); } } }; }');
  lines.push('  process(inputs, outputs){');
  lines.push('    var out = outputs[0];');
  lines.push('    if(out && out.length){');
  lines.push('      processBlock(this.state, sampleRate, out[0], out.length > 1 ? out[1] : out[0]);');
  lines.push('      if(this.state.voiceErrors && this.state.voiceErrors.length){ this.port.postMessage({ type: "voiceError", data: this.state.voiceErrors }); this.state.voiceErrors = []; }');
  lines.push('      if(__opts.collectDisplay){ var disp = this.state.display;');
  lines.push('        if(disp && this.state.dispIdx >= disp[0].length){ var arr = []; for(var k = 0; k < disp.length; k++){ arr.push(disp[k].slice(0)); } this.port.postMessage({ type: "display", data: arr }); this.state.dispIdx = 0; } }');
  lines.push('    }');
  lines.push('    return true;');
  lines.push('  }');
  lines.push('}');
  lines.push("registerProcessor('" + processorName + "', " + clsName + ");");
  return lines.join('\n');
}
