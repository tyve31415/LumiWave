/* =========================================================
   音频引擎：多实例合成引擎 + 共享 Web Audio 图 + 大通道路由
   · SynthEngine 类：每个「大通道」一个实例
     - ch1 混音器（16 声部 UI + 钢琴 + 演示曲/MIDI）
     - ch2 时间线（时间线歌曲专用引擎）
     - ch4 音序器（步进音序专用引擎，gateMode=seq-only）
     - ch3 本地音乐由 audio-player 直接接入通道路由
   · 共享：AudioContext、总输出（总音量/压缩/声像/主分析器）
   · 录音：在总输出后插入 ScriptProcessor 采样点，录制全部通道混合
   ========================================================= */
'use strict';

import { el } from './dom.js';
import { bus } from './bus.js';
import { CHANNELS, createState, processBlock, applyMessage, compileVoice, buildWorkletSource } from './dsp.js';
import { SONG_DATA, SONG_LEN, SONG_TPS, applySong } from './song.js';
import { PRESETS, createDemoSong } from './presets.js';
import { parseMidi, analyzeMidi } from './midi.js';
import { toArrayBuffer } from './util.js';
import { initChannelRouting, connectChannelSource } from './channels.js';

/* ---------- 共享音频图状态 ---------- */
export let ctx = null;
export let analyser = null;
export let spectrumAnalyser = null;
export let masterGain = null;
export let compNode = null;
export let panNode = null;
export let timeData = null;
export let freqData = null;
export let volumeLevel = 0.8;

let recTap = null;
let recTapActive = false;

export function showError(msg) { el.error.textContent = msg; }

export function matchPreset(src) {
  for (let p = 0; p < PRESETS.length; p++) {
    if (PRESETS[p].code === src) return p;
  }
  return -1;
}

/* ---------- 合成引擎类（每大通道一个实例） ---------- */
export class SynthEngine {
  constructor(opts) {
    this.id = opts.id;                 // 对应通道 id（ch1/ch2/ch4）
    this.label = opts.label || opts.id;
    this.isMain = !!opts.isMain;       // 主引擎：驱动播放按钮/状态栏/琴键高亮
    this.collectDisplay = !!opts.collectDisplay;  // 是否回传 16 声部波形（主示波器分栏用）
    this.ephemeralVoices = !!opts.ephemeralVoices; // 声部为临时生成，停止时不还原
    this.gateMode = opts.gateMode || 'normal';     // 'normal' | 'seq-only'
    this.sPrefix = this.id + '_';      // 该引擎在 worklet 内的 S/P 函数前缀

    this.running = false;
    this.baseFreq = 440;
    this.glide = 0;
    this.attack = 0.005;
    this.release = 0.12;
    this.songPlaying = false;
    this.currentSong = null;
    this.node = null;
    this.workletNode = null;
    this.fallbackState = null;
    this.savedVoices = null;
    this.lastLoadedVoices = null;
    this.voiceUIUpdater = null;
    this.seqProvider = null;
    this.voices = [];
    this.voiceDisplay = [];
    this.heldOrder = [];
    this.heldSet = {};

    for (let i = 0; i < CHANNELS; i++) {
      this.voices.push({ enabled: false, gain: 0.3, source: 'sin(TWO_PI * freq * t) * 0.2 * env', error: '' });
      if (this.collectDisplay) this.voiceDisplay.push(new Float32Array(512));
    }
  }

  setVoiceUIUpdater(fn) { this.voiceUIUpdater = fn; }
  setSeqProvider(fn) { this.seqProvider = fn; }

  refreshVoiceUI() { if (this.voiceUIUpdater) this.voiceUIUpdater(); }

  handleVoiceErrors(errs) {
    for (let i = 0; i < errs.length; i++) {
      const info = errs[i];
      const v = this.voices[info.index];
      if (!v) continue;
      v.enabled = false;
      v.error = '运行时错误，声部已停用：' + (info.message || '未知错误');
      this.send({ type: 'voice', index: info.index, gain: v.gain, enabled: false });
      showError('[' + this.label + '] V' + (info.index + 1) + ' 运行时出错，已自动停用该声部');
    }
    this.refreshVoiceUI();
  }

  send(m) {
    if (this.workletNode && this.workletNode.port) this.workletNode.port.postMessage(m);
    else if (this.fallbackState) applyMessage(this.fallbackState, m);
  }

  compileCheck(src) {
    const s = (src || '').trim();
    if (!s) return { ok: false, err: '函数不能为空' };
    if (/\b(for|while)\s*\(|\bdo\s*\{/.test(s)) return { ok: false, err: '不支持循环语句（for/while/do），函数必须立即返回' };
    try {
      const f = compileVoice(s);
      const test = f(0, 440, 1);
      if (typeof test !== 'number' || !isFinite(test)) return { ok: false, err: '函数必须返回一个数值' };
      return { ok: true };
    } catch (e) { return { ok: false, err: e.message }; }
  }

  syncVoices() {
    const payload = [];
    for (let i = 0; i < CHANNELS; i++) {
      const v = this.voices[i];
      const base = { gain: v.gain };
      // 无论启停都做编译检查：语法错误必须始终暴露给用户
      const chk = this.compileCheck(v.source);
      if (!v.enabled) {
        payload.push(Object.assign({ source: '0', enabled: false }, base));
        v.error = chk.ok ? '' : chk.err;
      } else if (chk.ok) {
        payload.push(Object.assign({ source: v.source.trim(), enabled: true }, base));
        v.error = '';
      } else {
        payload.push(Object.assign({ source: '0', enabled: false }, base));
        v.error = chk.err;
      }
    }
    this.send({ type: 'setVoices', voices: payload });
    this.refreshVoiceUI();
  }

  pushAllState() {
    this.send({ type: 'song', data: SONG_DATA, len: SONG_LEN, tps: SONG_TPS });
    this.send({ type: 'params', baseFreq: this.baseFreq, attack: this.attack, release: this.release, glide: this.glide });
    this.send({ type: 'running', on: this.running });
    this.syncVoices();
    if (this.seqProvider) this.seqProvider();
    for (let i = 0; i < this.heldOrder.length; i++) this.send({ type: 'noteOn', midi: this.heldOrder[i] });
  }

  /** 创建该引擎的 AudioWorklet / 兜底节点并接入本通道路由 */
  async ensureNode() {
    if (this.node || !ctx) return;
    if (typeof AudioWorkletNode === 'function') {
      try {
        const name = 'lumiwave-' + this.id;
        const src = buildWorkletSource(name, {
          collectDisplay: this.collectDisplay,
          gateMode: this.gateMode,
          sPrefix: this.sPrefix
        });
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const n = new AudioWorkletNode(ctx, name, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        const self = this;
        n.port.onmessage = function (e) {
          const d = e.data;
          if (!d) return;
          if (d.type === 'display') self.voiceDisplay = d.data;
          else if (d.type === 'voiceError') self.handleVoiceErrors(d.data);
        };
        this.workletNode = n;
        this.node = n;
      } catch (err) {
        this.workletNode = null;
      }
    }
    if (!this.node) {
      // 兜底模式：ScriptProcessor + 每引擎独立的歌曲数据与 S/P 函数
      this.fallbackState = createState({
        gateMode: this.gateMode,
        collectDisplay: this.collectDisplay,
        sPrefix: this.sPrefix
      });
      this.fallbackState.song = { data: [], len: 7296, tps: 51.2 };
      const st = this.fallbackState;
      const sp = this.sPrefix;
      window[sp + 'S'] = function (ch, t) {
        const arr = st.song.data[ch];
        if (!arr || !arr.length) return 0;
        let tick = (t * st.song.tps) % st.song.len;
        if (tick < 0) tick += st.song.len;
        let lo = 0, hi = (arr.length / 3) - 1, ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid * 3] <= tick) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (ans < 0) return 0;
        if (tick >= arr[ans * 3] + arr[ans * 3 + 1]) return 0;
        return window.midiToFreq(arr[ans * 3 + 2]);
      };
      window[sp + 'P'] = function (ch, t) {
        const arr = st.song.data[ch];
        if (!arr || !arr.length) return 0;
        let tick = (t * st.song.tps) % st.song.len;
        if (tick < 0) tick += st.song.len;
        let lo = 0, hi = (arr.length / 3) - 1, ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid * 3] <= tick) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (ans < 0) return 0;
        const start = arr[ans * 3];
        if (tick >= start + arr[ans * 3 + 1]) return 0;
        return (tick - start) / st.song.tps;
      };
      const self = this;
      const sproc = ctx.createScriptProcessor(2048, 0, 2);
      sproc.onaudioprocess = function (e) {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        processBlock(self.fallbackState, ctx.sampleRate, L, R);
        if (self.fallbackState.voiceErrors && self.fallbackState.voiceErrors.length) {
          self.handleVoiceErrors(self.fallbackState.voiceErrors);
          self.fallbackState.voiceErrors = [];
        }
        const disp = self.fallbackState.display;
        if (disp && disp.length && self.fallbackState.dispIdx >= disp[0].length) {
          self.voiceDisplay = disp.map(function (b) { return b.slice(0); });
          self.fallbackState.dispIdx = 0;
        }
      };
      this.node = sproc;
      showError('提示：当前环境不支持 AudioWorklet，已使用兼容模式（性能较低）');
    }
    connectChannelSource(this.id, this.node);
    this.pushAllState();
  }

  async ensureEngine() {
    await ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    await this.ensureNode();
    if (!this.running) {
      this.running = true;
      this.send({ type: 'running', on: true });
    }
    if (this.isMain) updatePlayButton();
    el.status.textContent = '运行 ' + this.label;
  }

  stopEngine() {
    if (!this.node) return;
    this.running = false;
    this.send({ type: 'running', on: false });
    if (this.isMain) updatePlayButton();
    el.status.textContent = '待机 STANDBY';
  }

  toggleEngine() {
    if (this.songPlaying) this.stopSong();
    else if (this.running) this.stopEngine();
    else this.ensureEngine();
  }

  /* ---------- 音符 ---------- */
  noteOn(midi) {
    this.ensureEngine();
    if (!this.heldSet[midi]) { this.heldSet[midi] = true; this.heldOrder.push(midi); }
    this.send({ type: 'noteOn', midi: midi });
    if (this.isMain) bus.emit('key-down', midi);
  }

  noteOff(midi) {
    if (this.heldSet[midi]) {
      delete this.heldSet[midi];
      const i = this.heldOrder.indexOf(midi);
      if (i >= 0) this.heldOrder.splice(i, 1);
    }
    this.send({ type: 'noteOff', midi: midi });
    if (this.isMain) bus.emit('key-up', midi);
  }

  allNotesOff() {
    const keys = this.heldOrder.slice();
    for (let i = 0; i < keys.length; i++) this.noteOff(keys[i]);
  }

  /* ---------- 歌曲播放（演示 / MIDI / 时间线） ---------- */
  saveVoices() {
    if (this.ephemeralVoices || this.savedVoices) return;
    this.savedVoices = this.voices.map(function (v) {
      return { enabled: v.enabled, gain: v.gain, source: v.source };
    });
  }

  loadVoices(voiceDefs) {
    for (let i = 0; i < CHANNELS; i++) {
      const d = voiceDefs[i];
      const v = this.voices[i];
      v.enabled = !!d;
      v.source = d ? d.source : 'sin(TWO_PI * freq * t) * 0.2 * env';
      v.gain = d ? d.gain : 0.3;
      v.error = '';
      if (v.el) {
        v.el.src.value = v.source;
        v.el.gain.value = String(Math.round(v.gain * 100));
        v.el.gval.textContent = Math.round(v.gain * 100) + '%';
        v.el.preset.value = String(matchPreset(v.source));
      }
    }
    this.lastLoadedVoices = this.voices.map(function (v) {
      return { enabled: v.enabled, gain: v.gain, source: v.source };
    });
    this.syncVoices();
  }

  restoreVoices() {
    if (this.ephemeralVoices) return true;
    if (!this.savedVoices) return true;
    let changed = false;
    if (this.lastLoadedVoices) {
      for (let i = 0; i < CHANNELS; i++) {
        const s = this.lastLoadedVoices[i];
        const v = this.voices[i];
        if (!s || v.enabled !== s.enabled || v.gain !== s.gain || v.source !== s.source) { changed = true; break; }
      }
    }
    if (changed && !window.confirm('停止播放将还原播放前的声部设置，播放期间的修改会丢失。\n确定停止并还原吗？')) {
      return false;
    }
    for (let i = 0; i < CHANNELS; i++) {
      const s = this.savedVoices[i];
      const v = this.voices[i];
      v.enabled = s.enabled; v.gain = s.gain; v.source = s.source;
      v.error = '';
      if (v.el) {
        v.el.src.value = v.source;
        v.el.gain.value = String(Math.round(v.gain * 100));
        v.el.gval.textContent = Math.round(v.gain * 100) + '%';
        v.el.preset.value = String(matchPreset(v.source));
      }
    }
    this.savedVoices = null;
    this.lastLoadedVoices = null;
    this.syncVoices();
    return true;
  }

  setSong(song) {
    applySong(song);
    this.send({ type: 'song', data: SONG_DATA, len: SONG_LEN, tps: SONG_TPS });
  }

  async startSong(song) {
    if (this.songPlaying) { if (!this.stopSong()) return false; }
    this.saveVoices();
    this.allNotesOff();
    this.setSong(song);
    this.loadVoices(song.voices);
    this.songPlaying = true;
    this.currentSong = song;
    await this.ensureEngine();
    this.send({ type: 'resetTime' });
    return true;
  }

  stopSong() {
    if (!this.songPlaying) return true;
    if (!this.restoreVoices()) return false;
    this.songPlaying = false;
    this.stopEngine();
    return true;
  }
}

/* ---------- 大通道引擎实例 ---------- */
export const mainEngine = new SynthEngine({ id: 'ch1', label: '混音器', isMain: true, collectDisplay: true });
export const timelineEngine = new SynthEngine({ id: 'ch2', label: '时间线', ephemeralVoices: true });
export const seqEngine = new SynthEngine({ id: 'ch4', label: '音序器', ephemeralVoices: true, gateMode: 'seq-only' });
mainEngine.currentSong = createDemoSong();

export function updatePlayButton() {
  el.playBtn.textContent = mainEngine.running ? '❚❚ 停止' : '▶ 播放';
  el.playBtn.classList.toggle('primary', !mainEngine.running);
}

/* ---------- 共享音频图 ---------- */
export async function ensureCtx() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { showError('当前环境不支持 Web Audio API'); return; }
  ctx = new AC();
  window.SR = ctx.sampleRate;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  timeData = new Float32Array(analyser.fftSize);
  spectrumAnalyser = ctx.createAnalyser();
  spectrumAnalyser.fftSize = 8192;
  spectrumAnalyser.smoothingTimeConstant = 0.6;
  freqData = new Uint8Array(spectrumAnalyser.frequencyBinCount);

  masterGain = ctx.createGain();
  masterGain.gain.value = volumeLevel;
  compNode = ctx.createDynamicsCompressor();
  compNode.threshold.value = -12;
  compNode.knee.value = 20;
  compNode.ratio.value = 6;
  compNode.attack.value = 0.003;
  compNode.release.value = 0.25;
  panNode = (typeof ctx.createStereoPanner === 'function') ? ctx.createStereoPanner() : null;

  // 大通道路由器：CH1–CH4 → 合并总线 / 独立总线 → 总输出
  initChannelRouting(ctx, masterGain);

  masterGain.connect(compNode);
  if (panNode) {
    compNode.connect(panNode);
    panNode.connect(analyser);
  } else {
    compNode.connect(analyser);
  }
  analyser.connect(spectrumAnalyser);
  spectrumAnalyser.connect(ctx.destination);

  await mainEngine.ensureNode();
}

/* ---------- 录音采样点：录制「总输出」（含全部通道混合结果） ---------- */
export function setRecordingTap(on) {
  if (!ctx) return;
  if (on && !recTapActive) {
    try {
      recTap = ctx.createScriptProcessor(4096, 2, 2);
      recTap.onaudioprocess = function (e) {
        bus.emit('record-samples', new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      masterGain.disconnect(compNode);
      masterGain.connect(recTap);
      recTap.connect(compNode);
      recTapActive = true;
    } catch (err) { recTap = null; }
  } else if (!on && recTapActive && recTap) {
    try {
      recTap.disconnect();
      masterGain.disconnect(recTap);
      masterGain.connect(compNode);
    } catch (err) { /* 忽略 */ }
    recTap.onaudioprocess = null;
    recTap = null;
    recTapActive = false;
  }
}

/* ---------- 主通道歌曲（演示 / MIDI） ---------- */
export async function startMainSong(song) {
  const ok = await mainEngine.startSong(song);
  if (!ok) return false;
  el.songTitle.textContent = '🎵 ' + song.name;
  el.songSub.textContent = (song.name === 'Funky Stars' ? '内置演示 · ' : '导入 MIDI · ') + song.data.length + ' 声道 · ' + song.bpm + ' BPM · 循环播放';
  el.demoBtn.textContent = '■ 停止';
  el.demoBtn.classList.add('on');
  el.status.textContent = '播放 ' + song.name;
  document.title = 'LumiWave · ' + song.name;
  return true;
}

export function stopMainSong() {
  if (!mainEngine.songPlaying) return true;
  if (!mainEngine.stopSong()) return false;
  el.demoBtn.textContent = '▶ 播放';
  el.demoBtn.classList.remove('on');
  document.title = 'LumiWave · 示波器合成器';
  return true;
}

export function toggleDemo() {
  if (mainEngine.songPlaying) stopMainSong();
  else startMainSong(mainEngine.currentSong || createDemoSong());
}

export function playDemoSong() {
  startMainSong(createDemoSong());
}

/** 载入 MIDI 内容（原生对话框 / 最近文件 / 拖放均汇聚于此） */
export async function loadMidiData(name, data) {
  try {
    const buf = toArrayBuffer(data);
    if (!buf) { showError('无法读取 MIDI 文件内容'); return; }
    const parsed = parseMidi(buf);
    const song = analyzeMidi(parsed, name);
    if (!song || !song.data.length) { showError('未在该 MIDI 中解析到音符'); return; }
    await startMainSong(song);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    const friendly = /outside the bounds|RangeError/i.test(msg) ? 'MIDI 文件损坏或格式不完整' : msg;
    showError('导入失败：' + friendly);
  }
}
