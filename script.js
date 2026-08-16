/* =========================================================
   示波器合成器 · Oscilloscope Synthesizer
   16 声部混音 + 进入/退出周期 + AudioWorklet 独立线程渲染
   + 内置演示歌曲《Funky Stars》(来自 MIDI)
   ========================================================= */
(function () {
  'use strict';

  const CHANNELS = 16;

  /* ---------- 波形/数学辅助函数（注入全局，供用户函数调用） ---------- */
  const TWO_PI = Math.PI * 2;
  const PI = Math.PI;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, x) { return a + (b - a) * x; }
  function sq(x) { return Math.sin(x) >= 0 ? 1 : -1; }
  function saw(x) { return 2 * (x / TWO_PI - Math.floor(x / TWO_PI)) - 1; }
  function tri(x) { return (2 / PI) * Math.asin(Math.sin(x)); }
  function pulse(x, w) { return Math.sin(x) >= (typeof w === 'number' ? w : 0) ? 1 : -1; }
  function noise() { return Math.random() * 2 - 1; }

  function noteFreq(name) {
    const m = /^([A-G])([#b]?)(-?[0-9]+)$/.exec(String(name).trim());
    if (!m) return 440;
    const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const semi = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
  function n(name) { return noteFreq(name); }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function midiName(m) { const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']; return N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function seq(notes, t, dur) {
    if (!Array.isArray(notes) || notes.length === 0) return 440;
    let i = Math.floor(t / dur) % notes.length;
    if (i < 0) i += notes.length;
    return typeof notes[i] === 'number' ? notes[i] : noteFreq(notes[i]);
  }

  /* 注入到 window（主线程兜底路径的 new Function 依赖它） */
  window.PI = PI;
  window.TWO_PI = TWO_PI;
  window.SR = 44100;
  window.sin = Math.sin; window.cos = Math.cos; window.tan = Math.tan;
  window.atan = Math.atan; window.atan2 = Math.atan2;
  window.abs = Math.abs; window.floor = Math.floor; window.ceil = Math.ceil; window.round = Math.round;
  window.pow = Math.pow; window.sqrt = Math.sqrt; window.exp = Math.exp; window.log = Math.log; window.log2 = Math.log2;
  window.min = Math.min; window.max = Math.max; window.random = Math.random; window.sign = Math.sign;
  window.clamp = clamp; window.lerp = lerp;
  window.sq = sq; window.saw = saw; window.tri = tri; window.pulse = pulse; window.noise = noise;
  window.n = n; window.noteFreq = noteFreq; window.midiToFreq = midiToFreq; window.seq = seq;

  /* ---------- 内置演示歌曲《Funky Stars》(来自 MIDI) ---------- */
  let SONG_BPM = window.SONG_BPM || 128;
  let SONG_DATA = window.SONG_DATA || [];
  let SONG_LEN = window.SONG_LEN || 7296;
  let SONG_PPQ = window.SONG_PPQ || 24;
  let SONG_TPS = SONG_PPQ * SONG_BPM / 60;

  function songSearch(arr, tick) {
    let lo = 0, hi = (arr.length / 3) - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid * 3] <= tick) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function S(ch, t) {
    const arr = SONG_DATA[ch];
    if (!arr || !arr.length) return 0;
    let tick = (t * SONG_TPS) % SONG_LEN;
    if (tick < 0) tick += SONG_LEN;
    const idx = songSearch(arr, tick);
    if (idx < 0) return 0;
    if (tick >= arr[idx * 3] + arr[idx * 3 + 1]) return 0;
    return midiToFreq(arr[idx * 3 + 2]);
  }

  function P(ch, t) {
    const arr = SONG_DATA[ch];
    if (!arr || !arr.length) return 0;
    let tick = (t * SONG_TPS) % SONG_LEN;
    if (tick < 0) tick += SONG_LEN;
    const idx = songSearch(arr, tick);
    if (idx < 0) return 0;
    const start = arr[idx * 3];
    if (tick >= start + arr[idx * 3 + 1]) return 0;
    return (tick - start) / SONG_TPS;
  }
  window.S = S;
  window.P = P;

  function setSong(song) {
    SONG_DATA = song.data || [];
    SONG_LEN = song.len || 7296;
    SONG_BPM = song.bpm || 128;
    SONG_PPQ = song.ppq || 24;
    SONG_TPS = SONG_PPQ * SONG_BPM / 60;
    send({ type: 'song', data: SONG_DATA, len: SONG_LEN, tps: SONG_TPS });
  }

  /* ---------- 音频核心（同一份逻辑：工作线程 + 兜底线程共用） ---------- */
  function isGateOpen(state) {
    if (state.held.length > 0) return true;
    if (state.seq.running) {
      const s = seqStepAt(state);
      return !!(s && s.on);
    }
    return true;
  }

  function seqStepAt(state) {
    const dur = 60 / state.seq.bpm / 4;
    let i = Math.floor((state.t - state.seq.t0) / dur);
    i = ((i % 16) + 16) % 16;
    return state.seq.steps[i];
  }

  function createState() {
    const display = [];
    for (let i = 0; i < CHANNELS; i++) display.push(new Float32Array(512));
    return {
      voices: [],
      display: display,
      dispIdx: 0,
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

  function compileVoice(src) {
    return new Function('t', 'freq', 'env', 'return (' + src + ');');
  }

  function processBlock(state, sr, L, R) {
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

  function applyMessage(state, m) {
    if (m.type === 'setVoices') {
      state.voices = m.voices.map(function (v) {
        return { fn: compileVoice(v.source), gain: v.gain, enabled: v.enabled };
      });
    } else if (m.type === 'voice') {
      const v = state.voices[m.index];
      if (v) { v.gain = m.gain; v.enabled = m.enabled; }
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

  function buildWorkletSource() {
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
    lines.push('var SONG_DATA = ' + JSON.stringify(SONG_DATA) + ';');
    lines.push('var SONG_LEN = ' + SONG_LEN + ';');
    lines.push('var SONG_TPS = ' + SONG_TPS + ';');
    lines.push('var S = ' + S.toString() + ';');
    lines.push('var P = ' + P.toString() + ';');
    lines.push('globalThis.TWO_PI = TWO_PI; globalThis.PI = PI; globalThis.SR = sampleRate;');
    lines.push('globalThis.sin = sin; globalThis.cos = cos; globalThis.tan = tan; globalThis.atan = atan; globalThis.atan2 = atan2; globalThis.abs = abs; globalThis.floor = floor; globalThis.ceil = ceil; globalThis.round = round; globalThis.pow = pow; globalThis.sqrt = sqrt; globalThis.exp = exp; globalThis.log = log; globalThis.log2 = log2; globalThis.min = min; globalThis.max = max; globalThis.random = random; globalThis.sign = sign;');
    for (let k = 0; k < names.length; k++) {
      lines.push('globalThis.' + names[k] + ' = ' + names[k] + ';');
    }
    lines.push('globalThis.n = n;');
    lines.push('globalThis.S = S; globalThis.P = P;');
    lines.push('class SynthProcessor extends AudioWorkletProcessor {');
    lines.push('  constructor(){ super(); this.state = createState(); this.recording = false; var self = this; this.port.onmessage = function(e){ var m = e.data; if(m.type === "record"){ self.recording = m.on; } else if(m.type === "song"){ SONG_DATA = m.data; SONG_LEN = m.len; SONG_TPS = m.tps; } else { applyMessage(self.state, m); } }; }');
    lines.push('  process(inputs, outputs){');
    lines.push('    var out = outputs[0];');
    lines.push('    if(out && out.length){');
    lines.push('      processBlock(this.state, sampleRate, out[0], out.length > 1 ? out[1] : out[0]);');
    lines.push('      if(this.state.voiceErrors && this.state.voiceErrors.length){ this.port.postMessage({ type: "voiceError", data: this.state.voiceErrors }); this.state.voiceErrors = []; }');
    lines.push('      if(this.recording){ this.port.postMessage({ type: "samples", data: out[0].slice(0) }); }');
    lines.push('      var disp = this.state.display;');
    lines.push('      if(disp && this.state.dispIdx >= disp[0].length){ var arr = []; for(var k = 0; k < disp.length; k++){ arr.push(disp[k].slice(0)); } this.port.postMessage({ type: "display", data: arr }); this.state.dispIdx = 0; }');
    lines.push('    }');
    lines.push('    return true;');
    lines.push('  }');
    lines.push('}');
    lines.push("registerProcessor('synth-processor', SynthProcessor);");
    return lines.join('\n');
  }

  /* ---------- 预设与默认声部 ---------- */
  const PRESETS = [
    { name: '正弦波', code: 'sin(TWO_PI * freq * t) * 0.5 * env' },
    { name: '方波', code: 'sq(TWO_PI * freq * t) * 0.25 * env' },
    { name: '锯齿波', code: 'saw(TWO_PI * freq * t) * 0.25 * env' },
    { name: '三角波', code: 'tri(TWO_PI * freq * t) * 0.4 * env' },
    { name: '窄脉冲', code: 'pulse(TWO_PI * freq * t, 0.4) * 0.2 * env' },
    { name: 'FM 金属', code: 'sin(TWO_PI * freq * t + 2.5 * sin(TWO_PI * freq * 2.01 * t)) * 0.3 * env' },
    { name: '琶音', code: "sin(TWO_PI * seq(['A3','C4','E4','A4','E4','C4'], t, 0.13) * t) * 0.4 * env" },
    { name: '芯片音色', code: '(pulse(TWO_PI * freq * t, 0.25) * 0.2 + saw(TWO_PI * freq * 2 * t) * 0.05) * env' },
    { name: '钟声', code: '(sin(TWO_PI * freq * t) + 0.5 * sin(TWO_PI * freq * 2.76 * t) + 0.25 * sin(TWO_PI * freq * 5.4 * t)) * exp(-4 * (t % 1.5)) * 0.4' },
    { name: '白噪声鼓', code: 'noise() * exp(-9 * (t % 0.5)) * 0.5' },
    { name: '氛围铺底', code: 'sin(TWO_PI * freq * t) * 0.3 + sin(TWO_PI * freq * 1.5 * t + sin(TWO_PI * 0.25 * t)) * 0.18' },
    { name: '扫频', code: 'sin(TWO_PI * (200 + 900 * ((t * 0.25) % 1)) * t) * 0.4 * env' },
    { name: '鸟叫声', code: 'sin(TWO_PI * (2000 + 2000 * min(1, (t % 0.45) / 0.12)) * (t % 0.45) + 6 * sin(TWO_PI * 38 * (t % 0.45))) * min(1, (t % 0.45) / 0.008) * exp(-22 * (t % 0.45)) * 0.4' }
  ];

  const VOICE_DEFAULTS = [
    { enabled: true,  source: 'sin(TWO_PI * freq * t) * 0.5 * env', gain: 100 },
    { enabled: true,  source: 'saw(TWO_PI * freq * t) * 0.25 * env', gain: 45 },
    { enabled: false, source: 'sin(TWO_PI * freq * t + 2.5 * sin(TWO_PI * freq * 2.01 * t)) * 0.3 * env', gain: 60 },
    { enabled: false, source: 'noise() * exp(-9 * (t % 0.5)) * 0.4', gain: 60 },
    { enabled: false, source: 'sq(TWO_PI * freq * t) * 0.2 * env', gain: 50 },
    { enabled: false, source: 'tri(TWO_PI * freq * t) * 0.35 * env', gain: 50 },
    { enabled: false, source: 'sin(TWO_PI * freq * 2 * t) * 0.12 * env', gain: 60 },
    { enabled: false, source: 'sin(TWO_PI * freq * t) * 0.25 + sin(TWO_PI * freq * 1.01 * t) * 0.15', gain: 50 },
    { enabled: false, source: 'pulse(TWO_PI * freq * t, 0.15) * 0.15 * env', gain: 50 },
    { enabled: false, source: 'sin(TWO_PI * freq * 3 * t) * 0.1 * env', gain: 50 },
    { enabled: false, source: 'saw(TWO_PI * freq * 0.5 * t) * 0.2 * env', gain: 50 },
    { enabled: false, source: 'tri(TWO_PI * freq * 2 * t) * 0.15 * env', gain: 50 },
    { enabled: false, source: 'noise() * 0.05', gain: 40 },
    { enabled: false, source: 'sin(TWO_PI * freq * t + sin(TWO_PI * 6 * t)) * 0.2 * env', gain: 50 },
    { enabled: false, source: 'sq(TWO_PI * freq * 1.5 * t) * 0.1 * env', gain: 50 },
    { enabled: false, source: 'sin(TWO_PI * freq * t) * 0.5 * env', gain: 50 }
  ];

  /* ---------- 演示声部（9 通道） ---------- */
  const DEMO_VOICES = [
    { source: 'S(0,t) ? sq(TWO_PI * S(0,t) * P(0,t)) * 0.16 : 0', gain: 0.7 },
    { source: 'S(1,t) ? sq(TWO_PI * S(1,t) * P(1,t)) * 0.11 : 0', gain: 0.55 },
    { source: 'S(2,t) ? tri(TWO_PI * S(2,t) * P(2,t)) * 0.13 : 0', gain: 0.5 },
    { source: 'S(3,t) ? noise() * exp(-20 * P(3,t)) * 0.7 : 0', gain: 0.85 },
    { source: 'S(4,t) ? (noise() * 0.6 + sin(TWO_PI * 180 * P(4,t)) * 0.4) * exp(-15 * P(4,t)) * 0.4 : 0', gain: 0.5 },
    { source: 'S(5,t) ? noise() * exp(-70 * P(5,t)) * 0.25 : 0', gain: 0.3 },
    { source: 'S(6,t) ? pulse(TWO_PI * S(6,t) * P(6,t), 0.2) * 0.1 : 0', gain: 0.55 },
    { source: 'S(7,t) ? tri(TWO_PI * S(7,t) * P(7,t)) * 0.28 : 0', gain: 0.6 },
    { source: 'S(8,t) ? sq(TWO_PI * S(8,t) * P(8,t)) * 0.14 : 0', gain: 0.65 },
    null, null, null, null, null, null, null
  ];

  const DEMO_SONG = {
    name: 'Funky Stars',
    bpm: window.SONG_BPM || 128,
    ppq: window.SONG_PPQ || 24,
    data: window.SONG_DATA || [],
    len: window.SONG_LEN || 7296,
    voices: DEMO_VOICES
  };
  let currentSong = DEMO_SONG;

  /* ---------- MIDI 导入与自动分析 ---------- */
  const DRUM_KICK = [35, 36];
  const DRUM_SNARE = [37, 38, 40];
  const DRUM_HAT = [42, 44, 46, 54];
  const DRUM_CYMBAL = [49, 51, 52, 53, 55, 57, 59];

  function readVarLen(view, pos) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= view.byteLength) throw new Error('MIDI 文件损坏（变长数值越界）');
      const b = view.getUint8(pos++);
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return [value, pos];
    }
    throw new Error('MIDI 文件损坏（变长数值过长）');
  }

  function parseMidi(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 14) throw new Error('文件太小');
    const hdr = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (hdr !== 'MThd') throw new Error('不是有效的 MIDI 文件');
    const hdrLen = view.getUint32(4);
    const format = view.getUint16(8);
    const ntrks = view.getUint16(10);
    const division = view.getUint16(12);
    if (division & 0x8000) throw new Error('不支持 SMPTE 时间码');
    const ppq = division;

    let pos = 8 + hdrLen;
    const tempos = [];
    const timeSigs = [];
    const notes = [];

    for (let t = 0; t < ntrks; t++) {
      if (pos + 8 > view.byteLength) break;
      const tLen = view.getUint32(pos + 4);
      pos += 8;
      const trackEnd = Math.min(pos + tLen, view.byteLength);
      let absTick = 0;
      let runningStatus = null;
      const raw = [];

      while (pos < trackEnd) {
        const rv = readVarLen(view, pos);
        absTick += rv[0]; pos = rv[1];
        let status = view.getUint8(pos);
        if (status === 0xFF) {
          pos++;
          const type = view.getUint8(pos++);
          const rl = readVarLen(view, pos); pos = rl[1];
          const ds = pos; pos += rl[0];
          if (type === 0x51 && rl[0] >= 3) {
            const us = (view.getUint8(ds) << 16) | (view.getUint8(ds + 1) << 8) | view.getUint8(ds + 2);
            tempos.push({ tick: absTick, bpm: Math.round(60000000 / us) });
          } else if (type === 0x58 && rl[0] >= 2) {
            timeSigs.push({ tick: absTick, num: view.getUint8(ds), den: Math.pow(2, view.getUint8(ds + 1)) });
          }
        } else if (status === 0xF0 || status === 0xF7) {
          const rl = readVarLen(view, pos + 1);
          pos = rl[1] + rl[0];
        } else if (status === 0xF1 || status === 0xF3) {
          pos += 1;
        } else if (status === 0xF2) {
          pos += 2;
        } else if (status >= 0xF4 && status <= 0xFE) {
          // 系统公共/实时消息（无数据字节）
        } else {
          if (status < 0x80) {
            status = runningStatus;
          } else {
            pos++;
            runningStatus = status;
          }
          if (status == null) break;
          const type = status & 0xF0;
          const ch = status & 0x0F;
          if (type === 0x80 || type === 0x90) {
            const note = view.getUint8(pos++);
            const vel = view.getUint8(pos++);
            raw.push({ tick: absTick, ch: ch, note: note, vel: vel, on: (type === 0x90 && vel > 0) });
          } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) { pos += 2; }
          else if (type === 0xC0 || type === 0xD0) { pos += 1; }
        }
      }

      const open = {};
      for (let k = 0; k < raw.length; k++) {
        const ev = raw[k];
        const key = ev.ch + ':' + ev.note;
        if (ev.on) {
          if (open[key]) notes.push({ tick: open[key].tick, dur: ev.tick - open[key].tick, ch: ev.ch, note: ev.note, vel: open[key].vel });
          open[key] = { tick: ev.tick, vel: ev.vel };
        } else {
          if (open[key]) { notes.push({ tick: open[key].tick, dur: ev.tick - open[key].tick, ch: ev.ch, note: ev.note, vel: open[key].vel }); delete open[key]; }
        }
      }
      pos = trackEnd;
    }

    return { format: format, ntrks: ntrks, ppq: ppq, tempos: tempos, timeSigs: timeSigs, notes: notes };
  }

  function gateForRole(role, ppq) {
    if (role === 'hat') return Math.max(2, Math.round(ppq / 8));
    if (role === 'cymbal') return ppq;
    return Math.round(ppq / 4);
  }

  function makeVoice(i, role, avgNote) {
    const sn = 'S(' + i + ',t)', pn = 'P(' + i + ',t)';
    if (role === 'kick') return { source: sn + ' ? noise() * exp(-20 * ' + pn + ') * 0.7 : 0', gain: 0.85 };
    if (role === 'snare') return { source: sn + ' ? (noise() * 0.6 + sin(TWO_PI * 180 * ' + pn + ') * 0.4) * exp(-15 * ' + pn + ') * 0.4 : 0', gain: 0.5 };
    if (role === 'hat') return { source: sn + ' ? noise() * exp(-70 * ' + pn + ') * 0.25 : 0', gain: 0.3 };
    if (role === 'cymbal') return { source: sn + ' ? noise() * exp(-12 * ' + pn + ') * 0.3 : 0', gain: 0.4 };
    if (role === 'perc') return { source: sn + ' ? noise() * exp(-30 * ' + pn + ') * 0.4 : 0', gain: 0.5 };
    if (avgNote < 48) return { source: sn + ' ? tri(TWO_PI * ' + sn + ' * ' + pn + ') * 0.28 : 0', gain: 0.6 };
    if (avgNote >= 64) return { source: sn + ' ? sq(TWO_PI * ' + sn + ' * ' + pn + ') * 0.13 : 0', gain: 0.65 };
    return { source: sn + ' ? sq(TWO_PI * ' + sn + ' * ' + pn + ') * 0.16 : 0', gain: 0.6 };
  }

  function analyzeMidi(parsed, fileName) {
    const ppq = parsed.ppq;
    const notes = parsed.notes;
    if (!notes || !notes.length) return null;
    const bpm = parsed.tempos.length ? parsed.tempos[0].bpm : 120;
    const ts = parsed.timeSigs.length ? parsed.timeSigs[0] : { num: 4, den: 4 };
    const ticksPerBar = ppq * ts.num * 4 / Math.max(1, ts.den);

    const byCh = {};
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      (byCh[n.ch] = byCh[n.ch] || []).push(n);
    }

    const songChannels = [];
    const chList = Object.keys(byCh).map(Number).sort(function (a, b) { return a - b; });
    for (let ci = 0; ci < chList.length && songChannels.length < 16; ci++) {
      const ch = chList[ci];
      const chNotes = byCh[ch].slice().sort(function (a, b) { return a.tick - b.tick; });
      const uniq = new Set(chNotes.map(function (n) { return n.note; }));
      const isDrum = (ch === 9) || (uniq.size <= 8 && Array.from(uniq).every(function (m) { return m >= 30 && m <= 62; }));
      if (isDrum) {
        const groups = { kick: [], snare: [], hat: [], cymbal: [], perc: [] };
        for (let i = 0; i < chNotes.length; i++) {
          const n = chNotes[i];
          let g = 'perc';
          if (DRUM_KICK.indexOf(n.note) >= 0) g = 'kick';
          else if (DRUM_SNARE.indexOf(n.note) >= 0) g = 'snare';
          else if (DRUM_HAT.indexOf(n.note) >= 0) g = 'hat';
          else if (DRUM_CYMBAL.indexOf(n.note) >= 0) g = 'cymbal';
          groups[g].push(n);
        }
        const order = ['kick', 'snare', 'hat', 'cymbal', 'perc'];
        for (let gi = 0; gi < order.length && songChannels.length < 16; gi++) {
          if (groups[order[gi]].length) songChannels.push({ role: order[gi], events: groups[order[gi]] });
        }
      } else {
        let sum = 0;
        for (let i = 0; i < chNotes.length; i++) sum += chNotes[i].note;
        songChannels.push({ role: 'melodic', events: chNotes, avgNote: sum / chNotes.length });
      }
    }

    const data = [];
    const voices = [];
    let maxEnd = 0;
    for (let i = 0; i < songChannels.length; i++) {
      const sc = songChannels[i];
      const flat = [];
      for (let k = 0; k < sc.events.length; k++) {
        const n = sc.events[k];
        let dur = Math.max(1, Math.round(n.dur));
        if (sc.role !== 'melodic') dur = gateForRole(sc.role, ppq);
        flat.push(n.tick, dur, n.note);
        if (n.tick + dur > maxEnd) maxEnd = n.tick + dur;
      }
      data.push(flat);
      voices.push(makeVoice(i, sc.role, sc.avgNote || 60));
    }

    const len = Math.ceil(maxEnd / ticksPerBar) * ticksPerBar;
    return { data: data, len: len, bpm: bpm, ppq: ppq, voices: voices, name: String(fileName || '导入的歌曲').replace(/\.midi?$/i, '') };
  }

  /* ---------- DOM ---------- */
  const statusEl = document.getElementById('status');
  const scope = document.getElementById('scope');
  const sctx = scope.getContext('2d');
  const scopeMulti = document.getElementById('scopeMulti');
  const mctx = scopeMulti.getContext('2d');
  const viewToggle = document.getElementById('viewToggle');
  const freqReadout = document.getElementById('freqReadout');
  const playBtn = document.getElementById('playBtn');
  const demoBtn = document.getElementById('demoBtn');
  const volumeEl = document.getElementById('volume');
  const volumeVal = document.getElementById('volumeVal');
  const freqEl = document.getElementById('freq');
  const freqVal = document.getElementById('freqVal');
  const panEl = document.getElementById('pan');
  const panVal = document.getElementById('panVal');
  const glideEl = document.getElementById('glide');
  const glideVal = document.getElementById('glideVal');
  const applyBtn = document.getElementById('applyBtn');
  const errorEl = document.getElementById('error');
  const attackEl = document.getElementById('attack');
  const attackVal = document.getElementById('attackVal');
  const releaseEl = document.getElementById('release');
  const releaseVal = document.getElementById('releaseVal');
  const seqPlayBtn = document.getElementById('seqPlay');
  const bpmEl = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  const seqClearBtn = document.getElementById('seqClear');
  const seqRandomBtn = document.getElementById('seqRandom');
  const seqGrid = document.getElementById('seqGrid');
  const pianoEl = document.getElementById('piano');
  const recordBtn = document.getElementById('recordBtn');
  const downloadLink = document.getElementById('download');
  const voicesEl = document.getElementById('voices');
  // 时间线编辑器控件
  const tlPlayBtn = document.getElementById('tlPlay');
  const tlStopBtn = document.getElementById('tlStop');
  const tlBpmEl = document.getElementById('tlBpm');
  const tlBpmVal = document.getElementById('tlBpmVal');
  const tlBarsEl = document.getElementById('tlBars');
  const tlBarsVal = document.getElementById('tlBarsVal');
  const tlPitchEl = document.getElementById('tlPitch');
  const tlClearBtn = document.getElementById('tlClear');
  const tlDeleteBtn = document.getElementById('tlDelete');
  const tlContent = document.getElementById('tlContent');
  // 音频播放器控件
  const audioImportBtn = document.getElementById('audioImport');
  const audioPlayBtn = document.getElementById('audioPlay');
  const audioStopBtn = document.getElementById('audioStop');
  const audioLoopBtn = document.getElementById('audioLoop');
  const audioVolEl = document.getElementById('audioVol');
  const audioVolVal = document.getElementById('audioVolVal');
  const audioFile = document.getElementById('audioFile');
  const audioSeek = document.getElementById('audioSeek');
  const audioTime = document.getElementById('audioTime');
  const audioWave = document.getElementById('audioWave');
  const audioSpectrum = document.getElementById('audioSpectrum');
  const awctx = audioWave.getContext('2d');
  const asctx = audioSpectrum.getContext('2d');
  const songTitle = document.getElementById('songTitle');
  const songSub = document.getElementById('songSub');
  const importBtn = document.getElementById('importBtn');
  const midiFile = document.getElementById('midiFile');
  const demoResetBtn = document.getElementById('demoResetBtn');

  /* ---------- 状态 ---------- */
  let ctx = null, analyser = null, spectrumAnalyser = null, masterGain = null, compNode = null, panNode = null;
  let node = null, workletNode = null, fallbackState = null;
  let running = false;
  let recording = false;
  let recStartWall = 0;
  const MAX_REC_MS = 15 * 60 * 1000;
  let recChunks = [];
  let volumeLevel = 0.5;
  let baseFreq = 440;
  let glide = 0;
  let attack = 0.005;
  let release = 0.12;
  let songPlaying = false;

  let voices = [];
  let voiceDisplay = [];
  // 时间线状态
  let tlNotes = [];
  let tlWaves = [];
  let tlLanes = [];
  let tlPlayheadEl = null;
  let tlSelected = null;
  let tlBpm = 120;
  let tlBars = 8;
  let tlPlaying = false;
  let tlStarting = false;
  let tlStartWall = 0;
  let tlNewMidi = 69;
  // 音频播放器状态
  let audioEl = null;
  let audioSrcNode = null;
  let audioAnalyser = null;
  let audioGain = null;
  let audioLoaded = false;
  let audioPlaying = false;
  let audioSeeking = false;
  let audioVol = 0.8;
  let audioWaveData = null;
  let audioFreqData = null;
  let awW = 0, awH = 0, asW = 0, asH = 0;
  const heldOrder = [];
  const heldSet = {};

  let seqRunning = false;
  let seqBpm = 120;
  let seqSteps = [];
  let seqCells = [];
  let seqStartWall = 0;

  let scopeMode = 'wave';
  let scopeAmp = 0.24;
  let scopeSamples = 2048;
  let specAmp = 1.0;
  let specCenter = 632.0;
  let specSpan = 20000.0;
  let scopeW = 0, scopeH = 0;
  let scopeMW = 0, scopeMH = 0;
  let timeData = null, freqData = null;
  let lastSeqStep = -1;

  function showError(msg) { errorEl.textContent = msg; }

  function handleVoiceErrors(errs) {
    for (let i = 0; i < errs.length; i++) {
      const info = errs[i];
      const v = voices[info.index];
      if (!v) continue;
      v.enabled = false;
      v.error = '运行时错误，声部已停用：' + (info.message || '未知错误');
      send({ type: 'voice', index: info.index, gain: v.gain, enabled: false });
      showError('V' + (info.index + 1) + ' 运行时出错，已自动停用该声部');
    }
    updateVoiceUI();
  }

  /* ---------- 音频图 ---------- */
  async function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { showError('当前浏览器不支持 Web Audio API'); return; }
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
    masterGain.gain.value = 0;
    compNode = ctx.createDynamicsCompressor();
    compNode.threshold.value = -12;
    compNode.knee.value = 20;
    compNode.ratio.value = 6;
    compNode.attack.value = 0.003;
    compNode.release.value = 0.25;
    panNode = (typeof ctx.createStereoPanner === 'function') ? ctx.createStereoPanner() : null;

    if (typeof AudioWorkletNode === 'function') {
      try {
        const src = buildWorkletSource();
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const n = new AudioWorkletNode(ctx, 'synth-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        n.port.onmessage = function (e) {
          const d = e.data;
          if (!d) return;
          if (d.type === 'samples') { if (recording) recChunks.push(d.data); }
          else if (d.type === 'display') voiceDisplay = d.data;
          else if (d.type === 'voiceError') handleVoiceErrors(d.data);
        };
        workletNode = n;
        node = n;
      } catch (err) {
        workletNode = null;
      }
    }

    if (!node) {
      fallbackState = createState();
      const sp = ctx.createScriptProcessor(2048, 0, 2);
      sp.onaudioprocess = function (e) {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        processBlock(fallbackState, ctx.sampleRate, L, R);
        if (fallbackState.voiceErrors && fallbackState.voiceErrors.length) {
          handleVoiceErrors(fallbackState.voiceErrors);
          fallbackState.voiceErrors = [];
        }
        if (recording) recChunks.push(new Float32Array(L));
        const disp = fallbackState.display;
        if (disp && fallbackState.dispIdx >= disp[0].length) {
          voiceDisplay = disp.map(function (b) { return b.slice(0); });
          fallbackState.dispIdx = 0;
        }
      };
      node = sp;
      showError('提示：当前浏览器不支持 AudioWorklet，已使用兼容模式（性能较低，推荐 Chrome / Edge / Firefox）');
    }

    node.connect(masterGain);
    masterGain.connect(compNode);
    if (panNode) {
      compNode.connect(panNode);
      panNode.connect(analyser);
    } else {
      compNode.connect(analyser);
    }
    analyser.connect(spectrumAnalyser);
    spectrumAnalyser.connect(ctx.destination);

    pushAllState();
  }

  function send(m) {
    if (workletNode && workletNode.port) workletNode.port.postMessage(m);
    else if (fallbackState) applyMessage(fallbackState, m);
  }

  function pushAllState() {
    send({ type: 'song', data: SONG_DATA, len: SONG_LEN, tps: SONG_TPS });
    send({ type: 'params', baseFreq: baseFreq, attack: attack, release: release, glide: glide });
    send({ type: 'running', on: running });
    syncVoices();
    sendSeqState(false);
    for (let i = 0; i < heldOrder.length; i++) send({ type: 'noteOn', midi: heldOrder[i] });
  }

  /* ---------- 声部编译与同步 ---------- */
  function compileCheck(src) {
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

  function syncVoices() {
    const payload = [];
    for (let i = 0; i < CHANNELS; i++) {
      const v = voices[i];
      const base = { gain: v.gain };
      if (!v.enabled) {
        payload.push(Object.assign({ source: '0', enabled: false }, base));
        v.error = '';
      } else {
        const chk = compileCheck(v.source);
        if (chk.ok) {
          payload.push(Object.assign({ source: v.source.trim(), enabled: true }, base));
          v.error = '';
        } else {
          payload.push(Object.assign({ source: '0', enabled: false }, base));
          v.error = chk.err;
        }
      }
    }
    send({ type: 'setVoices', voices: payload });
    updateVoiceUI();
  }

  function updateVoiceUI() {
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      v.el.enable.classList.toggle('on', v.enabled);
      v.el.err.textContent = v.error;
    }
  }

  /* ---------- 引擎启停 ---------- */
  async function ensureEngine() {
    await ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (!running) {
      running = true;
      send({ type: 'running', on: true });
      masterGain.gain.setTargetAtTime(volumeLevel, ctx.currentTime, 0.02);
    }
    updatePlayButton();
    statusEl.textContent = '运行 RUNNING';
  }

  function stopEngine() {
    if (!ctx) return;
    running = false;
    send({ type: 'running', on: false });
    masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    if (seqRunning) {
      seqRunning = false;
      lastSeqStep = -1;
      seqPlayBtn.textContent = '▶ 播放音序';
      sendSeqState(false);
    }
    updatePlayButton();
    statusEl.textContent = '待机 STANDBY';
  }

  function updatePlayButton() {
    playBtn.textContent = running ? '❚❚ 停止' : '▶ 播放';
    playBtn.classList.toggle('primary', !running);
  }

  /* ---------- 歌曲播放（演示 / 导入 MIDI） ---------- */
  let savedVoices = null;
  let lastLoadedVoices = null;
  function saveVoices() {
    if (!savedVoices) {
      savedVoices = voices.map(function (v) {
        return { enabled: v.enabled, gain: v.gain, source: v.source };
      });
    }
  }
  function matchPreset(src) {
    for (let p = 0; p < PRESETS.length; p++) {
      if (PRESETS[p].code === src) return p;
    }
    return -1;
  }

  function loadVoices(voiceDefs) {
    for (let i = 0; i < CHANNELS; i++) {
      const d = voiceDefs[i];
      const v = voices[i];
      v.enabled = !!d;
      v.source = d ? d.source : 'sin(TWO_PI * freq * t) * 0.2 * env';
      v.gain = d ? d.gain : 0.3;
      v.error = '';
      v.el.src.value = v.source;
      v.el.gain.value = String(Math.round(v.gain * 100));
      v.el.gval.textContent = Math.round(v.gain * 100) + '%';
      v.el.preset.value = String(matchPreset(v.source));
    }
    lastLoadedVoices = voices.map(function (v) {
      return { enabled: v.enabled, gain: v.gain, source: v.source };
    });
    syncVoices();
  }
  function restoreVoices() {
    if (!savedVoices) return true;
    let changed = false;
    if (lastLoadedVoices) {
      for (let i = 0; i < CHANNELS; i++) {
        const s = lastLoadedVoices[i];
        const v = voices[i];
        if (!s || v.enabled !== s.enabled || v.gain !== s.gain || v.source !== s.source) { changed = true; break; }
      }
    }
    if (changed && !window.confirm('停止播放将还原播放前的声部设置，播放期间的修改会丢失。\n确定停止并还原吗？')) {
      return false;
    }
    for (let i = 0; i < CHANNELS; i++) {
      const s = savedVoices[i];
      const v = voices[i];
      v.enabled = s.enabled; v.gain = s.gain; v.source = s.source;
      v.error = '';
      v.el.src.value = v.source;
      v.el.gain.value = String(Math.round(v.gain * 100));
      v.el.gval.textContent = Math.round(v.gain * 100) + '%';
      v.el.preset.value = String(matchPreset(v.source));
    }
    savedVoices = null;
    lastLoadedVoices = null;
    syncVoices();
    return true;
  }

  async function startSong(song) {
    if (songPlaying) { if (!stopSong()) return false; }
    saveVoices();
    if (seqRunning) {
      seqRunning = false;
      seqPlayBtn.textContent = '▶ 播放音序';
      lastSeqStep = -1;
      sendSeqState(false);
    }
    allNotesOff();
    setSong(song);
    loadVoices(song.voices);
    songPlaying = true;
    currentSong = song;
    songTitle.textContent = '🎵 ' + song.name;
    songSub.textContent = (song.name === 'Funky Stars' ? '内置演示 · ' : '导入 MIDI · ') + song.data.length + ' 声道 · ' + song.bpm + ' BPM · 循环播放';
    demoBtn.textContent = '■ 停止';
    demoBtn.classList.add('on');
    await ensureEngine();
    statusEl.textContent = '播放 ' + song.name;
    send({ type: 'resetTime' });
    return true;
  }

  function stopSong() {
    if (!songPlaying) return true;
    if (!restoreVoices()) return false;
    songPlaying = false;
    demoBtn.textContent = '▶ 播放';
    demoBtn.classList.remove('on');
    stopEngine();
    return true;
  }

  async function handleMidiFile(file) {
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    if (!/\.midi?$/.test(name)) { showError('请选择 .mid / .midi 文件'); return; }
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseMidi(buf);
      const song = analyzeMidi(parsed, file.name);
      if (!song || !song.data.length) { showError('未在该 MIDI 中解析到音符'); return; }
      startSong(song);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      const friendly = /outside the bounds|RangeError/i.test(msg) ? 'MIDI 文件损坏或格式不完整' : msg;
      showError('导入失败：' + friendly);
    }
  }

  /* ---------- 音符 ---------- */
  function noteOn(midi) {
    ensureEngine();
    if (!heldSet[midi]) { heldSet[midi] = true; heldOrder.push(midi); }
    send({ type: 'noteOn', midi: midi });
    highlightKey(midi, true);
  }

  function noteOff(midi) {
    if (heldSet[midi]) {
      delete heldSet[midi];
      const i = heldOrder.indexOf(midi);
      if (i >= 0) heldOrder.splice(i, 1);
    }
    send({ type: 'noteOff', midi: midi });
    highlightKey(midi, false);
  }

  function allNotesOff() {
    const keys = heldOrder.slice();
    for (let i = 0; i < keys.length; i++) noteOff(keys[i]);
  }

  /* ---------- 示波器绘制 ---------- */
  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function resizeScope() {
    const a = fitCanvas(scope); scopeW = a.w; scopeH = a.h;
    const b = fitCanvas(scopeMulti); scopeMW = b.w; scopeMH = b.h;
    const c = fitCanvas(audioWave); awW = c.w; awH = c.h;
    const d = fitCanvas(audioSpectrum); asW = d.w; asH = d.h;
  }

  function drawGrid() {
    sctx.save();
    sctx.lineWidth = 1;
    sctx.strokeStyle = 'rgba(60,255,136,0.08)';
    const gx = 12, gy = 8;
    for (let i = 0; i <= gx; i++) {
      const x = (i / gx) * scopeW;
      sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, scopeH); sctx.stroke();
    }
    for (let i = 0; i <= gy; i++) {
      const y = (i / gy) * scopeH;
      sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(scopeW, y); sctx.stroke();
    }
    sctx.strokeStyle = 'rgba(60,255,136,0.20)';
    sctx.beginPath(); sctx.moveTo(0, scopeH / 2); sctx.lineTo(scopeW, scopeH / 2); sctx.stroke();
    sctx.beginPath(); sctx.moveTo(scopeW / 2, 0); sctx.lineTo(scopeW / 2, scopeH); sctx.stroke();
    sctx.restore();
  }

  function drawWave() {
    sctx.save();
    sctx.strokeStyle = '#4dff9a';
    sctx.lineWidth = 1.7;
    sctx.shadowColor = '#4dff9a';
    sctx.shadowBlur = 12;
    sctx.beginPath();
    const mid = scopeH / 2;
    const amp = scopeH * scopeAmp;
    const n = Math.min(scopeSamples, timeData.length);
    const start = Math.floor((timeData.length - n) / 2);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * scopeW;
      const y = mid - timeData[start + i] * amp;
      if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    }
    sctx.stroke();
    sctx.restore();
  }

  function drawSpectrum() {
    sctx.save();
    sctx.fillStyle = '#4dff9a';
    sctx.shadowColor = '#4dff9a';
    sctx.shadowBlur = 8;
    // 对数频率轴：显示范围由中心频率与带宽决定
    const sr = ctx ? ctx.sampleRate : 44100;
    const binHz = sr / 8192;
    const fMin = Math.max(20, specCenter - specSpan / 2);
    const fMax = Math.max(fMin + 20, Math.min(sr / 2, specCenter + specSpan / 2));
    const NB = 220;
    const logMin = Math.log(fMin);
    const logMax = Math.log(fMax);
    const n = freqData.length;
    const bw = scopeW / NB;
    for (let k = 0; k < NB; k++) {
      const f0 = Math.exp(logMin + (logMax - logMin) * k / NB);
      const f1 = Math.exp(logMin + (logMax - logMin) * (k + 1) / NB);
      const i0 = Math.floor(f0 / binHz);
      const i1 = Math.min(n - 1, Math.ceil(f1 / binHz));
      let peak = 0;
      for (let i = i0; i <= i1; i++) {
        if (freqData[i] > peak) peak = freqData[i];
      }
      const v = peak / 255;
      const h = Math.pow(v, 0.75) * scopeH * 0.95 * specAmp;
      sctx.fillRect(k * bw, scopeH - h, Math.max(1, bw - 1), h);
    }
    sctx.restore();
  }

  /* ---------- 示波器旋钮（垂直/水平） ---------- */
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
    // 外圈
    c.beginPath(); c.arc(cx, cy, r, 0, TWO_PI);
    c.strokeStyle = 'rgba(60,255,136,0.55)'; c.lineWidth = Math.max(1, r * 0.16); c.stroke();
    // 刻度（-135° ~ +135°）
    for (let i = 0; i <= 10; i++) {
      const a = (-135 + i * 27) * PI / 180;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (r * 0.55), cy + Math.sin(a) * (r * 0.55));
      c.lineTo(cx + Math.cos(a) * (r * 0.85), cy + Math.sin(a) * (r * 0.85));
      c.strokeStyle = 'rgba(60,255,136,0.35)'; c.lineWidth = 1; c.stroke();
    }
    // 指针
    const pa = (-135 + v * 270) * PI / 180;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(pa) * (r * 0.68), cy + Math.sin(pa) * (r * 0.68));
    c.strokeStyle = '#3cff88'; c.lineWidth = Math.max(1.5, r * 0.22);
    c.shadowColor = '#3cff88'; c.shadowBlur = 4;
    c.stroke();
    // 中心点
    c.beginPath(); c.arc(cx, cy, Math.max(1.2, r * 0.16), 0, TWO_PI);
    c.fillStyle = '#3cff88'; c.fill();
  }

  function bindKnob(cv, opts) {
    let dragging = false;
    let lastY = 0;
    function redraw() {
      const v = clamp(opts.get(), 0, 1);
      drawKnob(cv, v);
      opts.paint();
    }
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

  function initScopeKnobs() {
    const vertCv = document.getElementById('knobVert');
    const horizCv = document.getElementById('knobHoriz');
    const vertVal = document.getElementById('knobVertVal');
    const horizVal = document.getElementById('knobHorizVal');
    const specAmpCv = document.getElementById('knobSpecAmp');
    const centerCv = document.getElementById('knobCenter');
    const spanCv = document.getElementById('knobSpan');
    const specAmpVal = document.getElementById('knobSpecAmpVal');
    const centerVal = document.getElementById('knobCenterVal');
    const spanVal = document.getElementById('knobSpanVal');
    sizeKnob(vertCv);
    sizeKnob(horizCv);
    sizeKnob(specAmpCv);
    sizeKnob(centerCv);
    sizeKnob(spanCv);

    // 垂直：幅度 0.05x ~ 3.00x（对数手感，宽广程）
    bindKnob(vertCv, {
      get: function () { return Math.log(scopeAmp / 0.05) / Math.log(3.0 / 0.05); },
      set: function (v) { scopeAmp = Math.round(0.05 * Math.pow(3.0 / 0.05, v) * 100) / 100; },
      paint: function () { vertVal.textContent = scopeAmp.toFixed(2) + 'x'; }
    });
    // 时域·水平：64 ~ 2048 采样（对数，像真实示波器的 time/div）
    bindKnob(horizCv, {
      get: function () { return Math.log(scopeSamples / 64) / Math.log(2048 / 64); },
      set: function (v) { scopeSamples = Math.max(64, Math.min(2048, Math.round(64 * Math.pow(2048 / 64, v)))); },
      paint: function () {
        const sr = window.SR || 44100;
        horizVal.textContent = (scopeSamples / sr * 1000).toFixed(1) + ' ms';
      }
    });
    // 频域·幅度：0.2x ~ 3.0x（对数）
    bindKnob(specAmpCv, {
      get: function () { return Math.log(specAmp / 0.2) / Math.log(3.0 / 0.2); },
      set: function (v) { specAmp = Math.round(0.2 * Math.pow(3.0 / 0.2, v) * 100) / 100; },
      paint: function () { specAmpVal.textContent = specAmp.toFixed(1) + 'x'; }
    });
    // 频域·中心频率：50Hz ~ 15kHz（对数）
    bindKnob(centerCv, {
      get: function () { return Math.log(specCenter / 50) / Math.log(15000 / 50); },
      set: function (v) { specCenter = Math.round(50 * Math.pow(15000 / 50, v)); },
      paint: function () { centerVal.textContent = formatFreq(specCenter); }
    });
    // 频域·带宽：200Hz ~ 100kHz（对数）
    bindKnob(spanCv, {
      get: function () { return Math.log(specSpan / 200) / Math.log(100000 / 200); },
      set: function (v) { specSpan = Math.round(200 * Math.pow(100000 / 200, v)); },
      paint: function () { spanVal.textContent = formatFreq(specSpan); }
    });
  }

  function drawMulti() {
    if (!mctx || !scopeMW) return;
    mctx.fillStyle = '#020704';
    mctx.fillRect(0, 0, scopeMW, scopeMH);
    const COLS = 2;
    const ROWS = CHANNELS / COLS;
    const bandH = scopeMH / ROWS;
    const colW = scopeMW / COLS;
    mctx.font = '10px monospace';
    mctx.textBaseline = 'middle';
    // 左右两栏分隔线
    mctx.strokeStyle = 'rgba(60,255,136,0.16)';
    mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(scopeMW / 2, 0); mctx.lineTo(scopeMW / 2, scopeMH); mctx.stroke();
    for (let v = 0; v < CHANNELS; v++) {
      const col = v < ROWS ? 0 : 1;
      const row = v % ROWS;
      const x0 = col * colW;
      const y0 = row * bandH;
      const mid = y0 + bandH / 2;
      const enabled = voices[v] ? voices[v].enabled : false;
      // 水平分隔线
      mctx.strokeStyle = 'rgba(60,255,136,0.10)';
      mctx.lineWidth = 1;
      mctx.beginPath(); mctx.moveTo(x0, y0); mctx.lineTo(x0 + colW, y0); mctx.stroke();
      // 标签
      mctx.fillStyle = enabled ? 'rgba(60,255,136,0.85)' : 'rgba(60,255,136,0.28)';
      mctx.fillText('V' + (v + 1), x0 + 8, mid);
      // 中线
      mctx.strokeStyle = enabled ? 'rgba(60,255,136,0.15)' : 'rgba(60,255,136,0.05)';
      mctx.beginPath(); mctx.moveTo(x0 + 44, mid); mctx.lineTo(x0 + colW, mid); mctx.stroke();
      // 波形（幅度比例增大）
      const data = voiceDisplay[v];
      if (data && enabled) {
        mctx.strokeStyle = '#4dff9a';
        mctx.lineWidth = 1.4;
        mctx.shadowColor = '#4dff9a';
        mctx.shadowBlur = 7;
        const amp = bandH * 0.46;
        const tx0 = x0 + 44, txw = colW - 44 - 6;
        mctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const x = tx0 + (i / (data.length - 1)) * txw;
          const y = mid - data[i] * amp;
          if (i === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
        }
        mctx.stroke();
      }
    }
  }

  function displayFreq() {
    if (heldOrder.length > 0) return midiToFreq(heldOrder[heldOrder.length - 1]);
    if (seqRunning) {
      const s = seqSteps[seqStepIndexDisplay()];
      if (s && s.on) return midiToFreq(s.midi);
    }
    return baseFreq;
  }

  function seqStepIndexDisplay() {
    const durMs = 60 / seqBpm / 4 * 1000;
    let i = Math.floor((performance.now() - seqStartWall) / durMs);
    return ((i % 16) + 16) % 16;
  }

  let frameNo = 0;
  function draw() {
    requestAnimationFrame(draw);
    frameNo++;
    const active = running || audioPlaying || recording || seqRunning || tlPlaying;
    if (active || (frameNo % 24 === 0)) {
      sctx.fillStyle = 'rgba(2,7,4,0.24)';
      sctx.fillRect(0, 0, scopeW, scopeH);
      drawGrid();
      if (analyser) {
        if (scopeMode === 'wave') {
          analyser.getFloatTimeDomainData(timeData);
          drawWave();
        } else {
          spectrumAnalyser.getByteFrequencyData(freqData);
          drawSpectrum();
        }
      }
      if ((frameNo & 1) === 0) drawMulti();
      drawAudioScopes();
    }
    freqReadout.textContent = songPlaying ? (SONG_BPM + ' BPM') : (displayFreq().toFixed(1) + ' Hz');

    // 录音计时与时长上限
    if (recording && recStartWall) {
      recordBtn.textContent = '■ 停止录制 ' + formatTime((performance.now() - recStartWall) / 1000);
      if (performance.now() - recStartWall >= MAX_REC_MS) {
        showError('录音已达 ' + Math.round(MAX_REC_MS / 60000) + ' 分钟上限，已自动停止并导出');
        stopRecording();
      }
    }

    // 时间线播放头
    if (tlPlaying) {
      if (!songPlaying) {
        tlPlaying = false;
        setTimelineLock(false);
        if (tlPlayheadEl) tlPlayheadEl.style.display = 'none';
      } else if (tlPlayheadEl && !tlStarting) {
        const tlBeats = (performance.now() - tlStartWall) / 1000 * tlBpm / 60;
        const tlPos = (tlBeats % (tlBars * 4)) * TL_PX_PER_BEAT;
        tlPlayheadEl.style.display = 'block';
        tlPlayheadEl.style.left = (TL_HEAD_W + tlPos) + 'px';
      }
    }

    if (seqRunning) {
      const si = seqStepIndexDisplay();
      if (si !== lastSeqStep) {
        if (lastSeqStep >= 0 && seqCells[lastSeqStep]) seqCells[lastSeqStep].classList.remove('playing');
        if (seqCells[si]) seqCells[si].classList.add('playing');
        lastSeqStep = si;
      }
    } else if (lastSeqStep >= 0) {
      if (seqCells[lastSeqStep]) seqCells[lastSeqStep].classList.remove('playing');
      lastSeqStep = -1;
    }
  }

  /* ---------- 声部 UI ---------- */
  function buildVoices() {
    voicesEl.innerHTML = '';
    voices = [];
    for (let i = 0; i < CHANNELS; i++) {
      const def = VOICE_DEFAULTS[i];
      const row = document.createElement('div');
      row.className = 'voice';

      const enable = document.createElement('button');
      enable.className = 'voice-enable' + (def.enabled ? ' on' : '');
      enable.textContent = 'V' + (i + 1);

      const preset = document.createElement('select');
      preset.className = 'voice-preset';
      for (let p = 0; p < PRESETS.length; p++) {
        const o = document.createElement('option');
        o.value = String(p);
        o.textContent = PRESETS[p].name;
        preset.appendChild(o);
      }
      const customOpt = document.createElement('option');
      customOpt.value = '-1';
      customOpt.textContent = '自定义';
      preset.appendChild(customOpt);
      preset.value = String(matchPreset(def.source));

      const src = document.createElement('input');
      src.type = 'text';
      src.className = 'voice-src';
      src.value = def.source;
      src.spellcheck = false;

      const gain = document.createElement('input');
      gain.type = 'range';
      gain.min = '0'; gain.max = '100'; gain.value = String(def.gain);

      const gval = document.createElement('span');
      gval.className = 'val';
      gval.textContent = def.gain + '%';

      const gainWrap = document.createElement('label');
      gainWrap.className = 'voice-gain-wrap';
      gainWrap.appendChild(gain);
      gainWrap.appendChild(gval);

      const err = document.createElement('span');
      err.className = 'voice-err';

      row.appendChild(enable);
      row.appendChild(preset);
      row.appendChild(src);
      row.appendChild(gainWrap);
      row.appendChild(err);
      voicesEl.appendChild(row);

      const v = { enabled: def.enabled, gain: def.gain / 100, source: def.source, error: '' };
      v.el = { enable: enable, preset: preset, src: src, gain: gain, gval: gval, err: err };
      voices.push(v);

      (function (vi, idx) {
        enable.addEventListener('click', function () {
          vi.enabled = !vi.enabled;
          syncVoices();
        });
        preset.addEventListener('change', function () {
          const p = parseInt(preset.value, 10);
          if (p >= 0 && PRESETS[p]) {
            vi.source = PRESETS[p].code;
            vi.el.src.value = vi.source;
            syncVoices();
          }
        });
        src.addEventListener('input', function () { vi.source = src.value; });
        src.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); syncVoices(); } });
        gain.addEventListener('input', function () {
          vi.gain = parseFloat(gain.value) / 100;
          gval.textContent = gain.value + '%';
          send({ type: 'voice', index: idx, gain: vi.gain, enabled: vi.enabled && !vi.error });
        });
      })(v, i);
    }
  }

  /* ---------- 时间线编辑器 ---------- */
  const TL_PX_PER_BEAT = 40;
  const TL_HEAD_W = 150;
  const TL_ROW_H = 30;
  const TL_RULER_H = 22;
  const TL_WAVES = [['sq', '方波'], ['tri', '三角波'], ['saw', '锯齿波'], ['pulse', '脉冲波'], ['noise', '噪声']];

  function tlLanePx() { return tlBars * 4 * TL_PX_PER_BEAT; }

  function initTimeline() {
    tlNotes = [];
    tlWaves = [];
    tlLanes = [];
    for (let i = 0; i < CHANNELS; i++) { tlNotes.push([]); tlWaves.push('sq'); }
    tlPitchEl.innerHTML = '';
    for (let m = 36; m <= 96; m++) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = midiName(m);
      if (m === 69) o.selected = true;
      tlPitchEl.appendChild(o);
    }
    buildTimelineUI();
  }

  function buildTimelineUI() {
    tlContent.innerHTML = '';
    tlLanes = [];
    tlPlayheadEl = null;

    // 标尺
    const ruler = document.createElement('div');
    ruler.className = 'tl-ruler';
    ruler.style.left = TL_HEAD_W + 'px';
    ruler.style.width = tlLanePx() + 'px';
    ruler.style.height = TL_RULER_H + 'px';
    for (let b = 0; b <= tlBars * 4; b++) {
      const mark = document.createElement('span');
      mark.className = 'tl-mark' + (b % 4 === 0 ? ' strong' : '');
      mark.style.left = (b * TL_PX_PER_BEAT) + 'px';
      if (b % 4 === 0) mark.textContent = String(b / 4 + 1);
      ruler.appendChild(mark);
    }
    tlContent.appendChild(ruler);

    // 16 条轨道
    for (let i = 0; i < CHANNELS; i++) {
      const row = document.createElement('div');
      row.className = 'tl-track';
      row.style.top = (TL_RULER_H + i * TL_ROW_H) + 'px';
      row.style.height = TL_ROW_H + 'px';

      const head = document.createElement('div');
      head.className = 'tl-head';
      head.style.width = TL_HEAD_W + 'px';
      head.style.height = TL_ROW_H + 'px';
      const lab = document.createElement('span');
      lab.className = 'tl-label';
      lab.textContent = 'V' + (i + 1);
      head.appendChild(lab);
      const sel = document.createElement('select');
      sel.className = 'tl-wave';
      for (let w = 0; w < TL_WAVES.length; w++) {
        const o = document.createElement('option');
        o.value = TL_WAVES[w][0];
        o.textContent = TL_WAVES[w][1];
        if (TL_WAVES[w][0] === tlWaves[i]) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', (function (ch) { return function () { tlWaves[ch] = sel.value; }; })(i));
      head.appendChild(sel);
      row.appendChild(head);

      const lane = document.createElement('div');
      lane.className = 'tl-lane';
      lane.style.left = TL_HEAD_W + 'px';
      lane.style.width = tlLanePx() + 'px';
      lane.style.height = TL_ROW_H + 'px';
      lane.addEventListener('pointerdown', (function (ch) {
        return function (e) {
          if (e.target !== lane) return;
          e.preventDefault();
          const rect = lane.getBoundingClientRect();
          const beat = Math.max(0, Math.round((e.clientX - rect.left) / TL_PX_PER_BEAT * 4) / 4);
          tlNotes[ch].push({ start: beat, dur: 1, midi: tlNewMidi });
          tlSelected = null;
          renderTimelineNotes();
        };
      })(i));
      row.appendChild(lane);
      tlContent.appendChild(row);
      tlLanes.push(lane);
    }

    // 播放头
    const ph = document.createElement('div');
    ph.className = 'tl-playhead';
    ph.style.top = TL_RULER_H + 'px';
    ph.style.height = (CHANNELS * TL_ROW_H) + 'px';
    ph.style.display = 'none';
    tlContent.appendChild(ph);
    tlPlayheadEl = ph;

    tlContent.style.width = (TL_HEAD_W + tlLanePx() + 20) + 'px';
    tlContent.style.height = (TL_RULER_H + CHANNELS * TL_ROW_H) + 'px';
    renderTimelineNotes();
  }

  function renderTimelineNotes() {
    for (let i = 0; i < CHANNELS; i++) {
      const lane = tlLanes[i];
      if (!lane) continue;
      const olds = lane.querySelectorAll('.tl-note');
      for (let k = 0; k < olds.length; k++) olds[k].remove();
      for (let k = 0; k < tlNotes[i].length; k++) {
        const n = tlNotes[i][k];
        const div = document.createElement('div');
        const sel = tlSelected && tlSelected.ch === i && tlSelected.idx === k;
        div.className = 'tl-note' + (sel ? ' selected' : '');
        div.style.left = (n.start * TL_PX_PER_BEAT) + 'px';
        div.style.width = Math.max(10, n.dur * TL_PX_PER_BEAT - 2) + 'px';
        div.textContent = midiName(n.midi);
        div.title = midiName(n.midi) + ' · 第' + (n.start + 1).toFixed(2) + '拍 · 长' + n.dur.toFixed(2) + '拍';
        div.addEventListener('pointerdown', (function (ch, idx) { return function (e) { noteMouseDown(ch, idx, e); }; })(i, k));
        lane.appendChild(div);
      }
    }
  }

  function noteMouseDown(ch, idx, e) {
    e.preventDefault();
    e.stopPropagation();
    const isResize = (e.offsetX >= e.target.offsetWidth - 8);
    selectNote(ch, idx);
    const note = tlNotes[ch][idx];
    const lane = tlLanes[ch];
    const el = lane.querySelectorAll('.tl-note')[idx] || e.target;
    const startX = e.clientX;
    const origStart = note.start;
    const origDur = note.dur;
    const maxBeats = tlBars * 4;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    function onMove(ev) {
      const dx = (ev.clientX - startX) / TL_PX_PER_BEAT;
      if (isResize) {
        note.dur = Math.min(maxBeats - note.start, Math.max(0.25, Math.round((origDur + dx) * 4) / 4));
        el.style.width = Math.max(10, note.dur * TL_PX_PER_BEAT - 2) + 'px';
      } else {
        note.start = Math.max(0, Math.min(maxBeats - note.dur, Math.round((origStart + dx) * 4) / 4));
        el.style.left = (note.start * TL_PX_PER_BEAT) + 'px';
      }
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      renderTimelineNotes();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function selectNote(ch, idx) {
    tlSelected = { ch: ch, idx: idx };
    const n = tlNotes[ch][idx];
    if (n) {
      tlNewMidi = n.midi;
      tlPitchEl.value = String(n.midi);
    }
    renderTimelineNotes();
  }

  function deleteSelectedNote() {
    if (!tlSelected) return;
    const arr = tlNotes[tlSelected.ch];
    if (arr) arr.splice(tlSelected.idx, 1);
    tlSelected = null;
    renderTimelineNotes();
  }

  function makeTimelineVoice(i, wave) {
    const sn = 'S(' + i + ',t)', pn = 'P(' + i + ',t)';
    if (wave === 'noise') return { source: sn + ' ? noise() * exp(-14 * ' + pn + ') * 0.35 : 0', gain: 0.5 };
    let call, amp;
    if (wave === 'tri') { call = 'tri(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.22; }
    else if (wave === 'saw') { call = 'saw(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.16; }
    else if (wave === 'pulse') { call = 'pulse(TWO_PI * ' + sn + ' * ' + pn + ', 0.25)'; amp = 0.14; }
    else { call = 'sq(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.18; }
    return { source: sn + ' ? ' + call + ' * ' + amp + ' : 0', gain: 0.6 };
  }

  function buildTimelineSong() {
    const ppq = 24;
    const data = [];
    const voices = [];
    for (let i = 0; i < CHANNELS; i++) {
      const flat = [];
      const ns = tlNotes[i];
      for (let k = 0; k < ns.length; k++) {
        flat.push(Math.round(ns[k].start * ppq), Math.max(1, Math.round(ns[k].dur * ppq)), ns[k].midi);
      }
      data.push(flat);
      voices.push(makeTimelineVoice(i, tlWaves[i]));
    }
    return { data: data, len: tlBars * 4 * ppq, bpm: tlBpm, ppq: ppq, voices: voices, name: '时间线' };
  }

  function setTimelineLock(locked) {
    tlBpmEl.disabled = locked;
    tlBarsEl.disabled = locked;
  }

  async function playTimeline() {
    tlPlaying = true;
    tlStarting = true;
    setTimelineLock(true);
    let ok = false;
    try {
      ok = await startSong(buildTimelineSong());
    } finally {
      tlStarting = false;
    }
    if (!ok) {
      tlPlaying = false;
      setTimelineLock(false);
      return;
    }
    tlStartWall = performance.now();
  }

  function stopTimeline() {
    if (!stopSong()) return;
    tlPlaying = false;
    setTimelineLock(false);
    if (tlPlayheadEl) tlPlayheadEl.style.display = 'none';
  }

  /* ---------- 音频播放器（导入 wav/mp3/flac） ---------- */
  function initAudioPlayer() {
    audioEl = new Audio();
    audioEl.preload = 'metadata';
    audioEl.loop = false;
    audioEl.addEventListener('ended', function () {
      audioPlaying = false;
      audioPlayBtn.textContent = '▶ 播放';
    });
    audioEl.addEventListener('timeupdate', function () {
      if (audioEl.duration && !audioSeeking) {
        audioSeek.value = String(Math.round(audioEl.currentTime / audioEl.duration * 1000));
        audioTime.textContent = formatTime(audioEl.currentTime) + ' / ' + formatTime(audioEl.duration);
      }
    });
    audioEl.addEventListener('loadedmetadata', function () {
      audioTime.textContent = '0:00 / ' + formatTime(audioEl.duration);
    });
    audioEl.addEventListener('error', function () {
      if (audioLoaded) showError('音频加载失败：可能是浏览器不支持的格式');
    });
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  async function ensureAudioGraph() {
    await ensureCtx();
    if (!ctx || audioSrcNode) return;
    try {
      audioSrcNode = ctx.createMediaElementSource(audioEl);
    } catch (err) {
      return;
    }
    audioAnalyser = ctx.createAnalyser();
    audioAnalyser.fftSize = 2048;
    audioAnalyser.smoothingTimeConstant = 0.6;
    audioWaveData = new Float32Array(audioAnalyser.fftSize);
    audioFreqData = new Uint8Array(audioAnalyser.frequencyBinCount);
    audioGain = ctx.createGain();
    audioGain.gain.value = audioVol;
    audioSrcNode.connect(audioAnalyser);
    audioAnalyser.connect(audioGain);
    audioGain.connect(analyser); // 汇入主示波器，与合成器一起显示混合波形/频谱
  }

  async function importAudioFile(file) {
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    if (!/\.(wav|mp3|flac|ogg|m4a|aac|webm)$/.test(name)) { showError('请选择 WAV / MP3 / FLAC 等音频文件'); return; }
    if (audioPlaying) { audioEl.pause(); audioPlaying = false; audioPlayBtn.textContent = '▶ 播放'; }
    const url = URL.createObjectURL(file);
    const oldUrl = audioEl.dataset.url;
    audioEl.src = url;
    audioEl.load();
    if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (err) {} }
    audioEl.dataset.url = url;
    audioLoaded = true;
    await ensureAudioGraph();
    audioSeek.value = '0';
    audioTime.textContent = '0:00 / 0:00';
    statusEl.textContent = '音频 ' + file.name;
  }

  function drawAudioScopes() {
    if (!audioAnalyser || !audioLoaded) return;
    // 波形
    audioAnalyser.getFloatTimeDomainData(audioWaveData);
    awctx.fillStyle = 'rgba(2,7,4,0.24)';
    awctx.fillRect(0, 0, awW, awH);
    awctx.strokeStyle = '#4dff9a';
    awctx.lineWidth = 1.6;
    awctx.shadowColor = '#4dff9a';
    awctx.shadowBlur = 10;
    awctx.beginPath();
    const midW = awH / 2;
    const ampW = awH * 0.42;
    const nW = audioWaveData.length;
    for (let i = 0; i < nW; i++) {
      const x = (i / (nW - 1)) * awW;
      const y = midW - audioWaveData[i] * ampW;
      if (i === 0) awctx.moveTo(x, y); else awctx.lineTo(x, y);
    }
    awctx.stroke();
    // 频谱
    audioAnalyser.getByteFrequencyData(audioFreqData);
    asctx.fillStyle = 'rgba(2,7,4,0.24)';
    asctx.fillRect(0, 0, asW, asH);
    asctx.fillStyle = '#4dff9a';
    asctx.shadowColor = '#4dff9a';
    asctx.shadowBlur = 8;
    const nS = Math.min(audioFreqData.length, 160);
    const bw = asW / nS;
    for (let i = 0; i < nS; i++) {
      const h = (audioFreqData[i] / 255) * asH * 0.95;
      asctx.fillRect(i * bw, asH - h, Math.max(1, bw - 1), h);
    }
  }

  /* ---------- 音序器 ---------- */
  const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93];

  function sendSeqState(reset) {
    const steps = seqSteps.map(function (s) { return { on: s.on, midi: s.midi }; });
    send({ type: 'seq', running: seqRunning, bpm: seqBpm, reset: reset, steps: steps });
  }

  function buildSeqGrid() {
    seqGrid.innerHTML = '';
    seqCells = [];
    for (let i = 0; i < 16; i++) {
      const cell = document.createElement('div');
      cell.className = 'step';

      const sel = document.createElement('select');
      for (let m = 48; m <= 83; m++) {
        const opt = document.createElement('option');
        opt.value = String(m);
        opt.textContent = midiName(m);
        if (m === PENTA[i % PENTA.length]) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', function () {
        seqSteps[i].midi = parseInt(sel.value, 10);
        sendSeqState(false);
      });

      const led = document.createElement('div');
      led.className = 'led';
      led.addEventListener('click', function () {
        seqSteps[i].on = !seqSteps[i].on;
        led.classList.toggle('on', seqSteps[i].on);
        sendSeqState(false);
      });

      cell.appendChild(sel);
      cell.appendChild(led);
      seqGrid.appendChild(cell);
      seqCells.push(led);
    }
    initSeqSteps();
  }

  function initSeqSteps() {
    const rhythm = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1];
    seqSteps = [];
    for (let i = 0; i < 16; i++) {
      seqSteps.push({ on: rhythm[i] === 1, midi: PENTA[i % PENTA.length] });
      seqCells[i].classList.toggle('on', rhythm[i] === 1);
    }
    const selects = seqGrid.querySelectorAll('select');
    for (let j = 0; j < selects.length; j++) selects[j].value = String(seqSteps[j].midi);
  }

  /* ---------- 钢琴 ---------- */
  const KEYMAP = {
    z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59,
    q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71
  };
  const WHITE = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71];
  const BLACK = [49, 51, 54, 56, 58, 61, 63, 66, 68, 70];
  const keyElements = {};

  function keyHint(midi) {
    for (const key in KEYMAP) {
      if (KEYMAP[key] === midi) return key.toUpperCase();
    }
    return null;
  }

  function bindKey(el, midi) {
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); noteOn(midi); });
    el.addEventListener('pointerenter', function (e) { if (e.buttons & 1) noteOn(midi); });
    el.addEventListener('pointerup', function () { noteOff(midi); });
    el.addEventListener('pointerleave', function () { noteOff(midi); });
    el.addEventListener('pointercancel', function () { noteOff(midi); });
  }

  function highlightKey(midi, on) {
    const el = keyElements[midi];
    if (el) el.classList.toggle('active', on);
  }

  function buildPiano() {
    const whiteCount = WHITE.length;
    const ww = 100 / whiteCount;
    const bw = ww * 0.62;

    WHITE.forEach(function (midi, wi) {
      const k = document.createElement('div');
      k.className = 'key white';
      k.style.left = (wi * ww) + '%';
      k.style.width = ww + '%';
      k.style.height = '100%';
      k.style.top = '0';
      const hint = keyHint(midi);
      if (hint) k.innerHTML = '<span class="hint">' + hint + '</span>';
      bindKey(k, midi);
      pianoEl.appendChild(k);
      keyElements[midi] = k;
    });

    BLACK.forEach(function (midi) {
      const wi = WHITE.indexOf(midi - 1);
      const k = document.createElement('div');
      k.className = 'key black';
      k.style.left = ((wi + 1) * ww - bw / 2) + '%';
      k.style.width = bw + '%';
      k.style.height = '62%';
      k.style.top = '0';
      const hint = keyHint(midi);
      if (hint) k.innerHTML = '<span class="hint">' + hint + '</span>';
      bindKey(k, midi);
      pianoEl.appendChild(k);
      keyElements[midi] = k;
    });
  }

  /* ---------- 电脑键盘 ---------- */
  const pressedKeys = {};
  window.addEventListener('keydown', function (e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteSelectedNote(); return; }
    if (e.key === 'Backspace' && tlSelected) { e.preventDefault(); deleteSelectedNote(); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      if (songPlaying) stopSong();
      else if (running) stopEngine();
      else ensureEngine();
      return;
    }
    const k = e.key.toLowerCase();
    if (KEYMAP[k] === undefined) return;
    if (e.repeat || pressedKeys[k]) return;
    pressedKeys[k] = true;
    noteOn(KEYMAP[k]);
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    const k = e.key.toLowerCase();
    if (KEYMAP[k] === undefined) return;
    pressedKeys[k] = false;
    noteOff(KEYMAP[k]);
  });
  window.addEventListener('blur', function () {
    allNotesOff();
    for (const k in pressedKeys) pressedKeys[k] = false;
  });

  /* ---------- 录制导出 ---------- */
  recordBtn.addEventListener('click', async function () {
    await ensureCtx();
    if (!ctx) return;
    if (!recording) {
      recChunks = [];
      recording = true;
      recStartWall = performance.now();
      recordBtn.textContent = '■ 停止录制';
      send({ type: 'record', on: true });
    } else {
      await stopRecording();
    }
  });

  async function stopRecording() {
    if (!recording) return;
    recording = false;
    recStartWall = 0;
    recordBtn.textContent = '● 录制';
    send({ type: 'record', on: false });
    await exportWav();
  }

  async function exportWav() {
    let total = 0;
    recChunks.forEach(function (c) { total += c.length; });
    if (total === 0) { showError('没有录制到任何音频'); return; }
    const samples = new Float32Array(total);
    let off = 0;
    recChunks.forEach(function (c) { samples.set(c, off); off += c.length; });
    downloadLink.hidden = false;
    downloadLink.textContent = '⏳ 编码中…';
    try {
      const buffer = await encodeWavAsync(samples, ctx.sampleRate);
      const blob = new Blob([buffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      if (downloadLink.dataset.url) { try { URL.revokeObjectURL(downloadLink.dataset.url); } catch (err) {} }
      downloadLink.dataset.url = url;
      downloadLink.href = url;
      downloadLink.download = 'synth-' + Date.now() + '.wav';
      downloadLink.textContent = '⬇ 下载 WAV';
    } catch (err) {
      downloadLink.hidden = true;
      showError('导出失败：' + (err && err.message ? err.message : err));
    }
  }

  function encodeWavBuffer(samples, sampleRate) {
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);
    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * bytesPerSample, true);
    let off2 = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off2 += 2;
    }
    return buffer;
  }

  const WAV_WORKER_SRC = [
    'self.onmessage = function (e) {',
    '  var samples = new Float32Array(e.data.samples);',
    '  var sampleRate = e.data.sampleRate;',
    '  var bytesPerSample = 2;',
    '  var buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);',
    '  var view = new DataView(buffer);',
    '  function wstr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }',
    '  wstr(0, "RIFF");',
    '  view.setUint32(4, 36 + samples.length * bytesPerSample, true);',
    '  wstr(8, "WAVE"); wstr(12, "fmt ");',
    '  view.setUint32(16, 16, true);',
    '  view.setUint16(20, 1, true);',
    '  view.setUint16(22, 1, true);',
    '  view.setUint32(24, sampleRate, true);',
    '  view.setUint32(28, sampleRate * 2, true);',
    '  view.setUint16(32, 2, true);',
    '  view.setUint16(34, 16, true);',
    '  wstr(36, "data");',
    '  view.setUint32(40, samples.length * bytesPerSample, true);',
    '  var off = 44;',
    '  for (var i = 0; i < samples.length; i++) {',
    '    var s = samples[i]; if (s > 1) s = 1; else if (s < -1) s = -1;',
    '    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);',
    '    off += 2;',
    '  }',
    '  self.postMessage(buffer, [buffer]);',
    '};'
  ].join('\n');

  function encodeWavAsync(samples, sampleRate) {
    return new Promise(function (resolve, reject) {
      let worker = null;
      let url = null;
      try {
        url = URL.createObjectURL(new Blob([WAV_WORKER_SRC], { type: 'text/javascript' }));
        worker = new Worker(url);
      } catch (err) {
        resolve(encodeWavBuffer(samples, sampleRate));
        return;
      }
      worker.onmessage = function (e) {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(e.data);
      };
      worker.onerror = function () {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error('WAV 编码失败'));
      };
      worker.postMessage({ samples: samples.buffer, sampleRate: sampleRate }, [samples.buffer]);
    });
  }

  /* ---------- 控件事件 ---------- */
  playBtn.addEventListener('click', function () {
    if (songPlaying) stopSong();
    else if (running) stopEngine();
    else ensureEngine();
  });

  demoBtn.addEventListener('click', function () {
    if (songPlaying) stopSong(); else startSong(currentSong);
  });

  importBtn.addEventListener('click', function () { midiFile.click(); });
  midiFile.addEventListener('change', function () {
    if (midiFile.files && midiFile.files[0]) handleMidiFile(midiFile.files[0]);
    midiFile.value = '';
  });
  demoResetBtn.addEventListener('click', function () {
    currentSong = DEMO_SONG;
    startSong(DEMO_SONG);
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) {
      const nm = String(files[0].name || '').toLowerCase();
      if (/\.midi?$/.test(nm)) handleMidiFile(files[0]);
      else importAudioFile(files[0]);
    }
  });

  volumeEl.addEventListener('input', function () {
    volumeLevel = parseFloat(volumeEl.value) / 100;
    volumeVal.textContent = Math.round(volumeLevel * 100) + '%';
    if (ctx && masterGain) masterGain.gain.setTargetAtTime(volumeLevel, ctx.currentTime, 0.02);
  });

  freqEl.addEventListener('input', function () {
    baseFreq = parseFloat(freqEl.value);
    freqVal.textContent = baseFreq + ' Hz';
    send({ type: 'params', baseFreq: baseFreq, attack: attack, release: release, glide: glide });
  });

  panEl.addEventListener('input', function () {
    const p = parseFloat(panEl.value);
    panVal.textContent = p.toFixed(2);
    if (ctx && panNode) panNode.pan.setTargetAtTime(p, ctx.currentTime, 0.02);
  });

  glideEl.addEventListener('input', function () {
    glide = parseFloat(glideEl.value);
    glideVal.textContent = glide + ' ms';
    send({ type: 'params', baseFreq: baseFreq, attack: attack, release: release, glide: glide });
  });

  attackEl.addEventListener('input', function () {
    attack = parseFloat(attackEl.value) / 1000;
    attackVal.textContent = attackEl.value + ' ms';
    send({ type: 'params', baseFreq: baseFreq, attack: attack, release: release, glide: glide });
  });

  releaseEl.addEventListener('input', function () {
    release = parseFloat(releaseEl.value) / 1000;
    releaseVal.textContent = releaseEl.value + ' ms';
    send({ type: 'params', baseFreq: baseFreq, attack: attack, release: release, glide: glide });
  });

  applyBtn.addEventListener('click', function () { syncVoices(); });

  viewToggle.addEventListener('click', function () {
    scopeMode = scopeMode === 'wave' ? 'spectrum' : 'wave';
    viewToggle.textContent = scopeMode === 'wave' ? '波形' : '频谱';
  });

  tlPlayBtn.addEventListener('click', function () { playTimeline(); });
  tlStopBtn.addEventListener('click', function () { stopTimeline(); });
  tlBpmEl.addEventListener('input', function () {
    tlBpm = parseFloat(tlBpmEl.value);
    tlBpmVal.textContent = tlBpm + ' BPM';
  });
  tlBarsEl.addEventListener('input', function () {
    tlBars = parseFloat(tlBarsEl.value);
    tlBarsVal.textContent = tlBars + ' 小节';
    const maxBeats = tlBars * 4;
    for (let i = 0; i < CHANNELS; i++) {
      tlNotes[i] = tlNotes[i].filter(function (n) { return n.start + n.dur <= maxBeats + 1e-6; });
    }
    tlSelected = null;
    buildTimelineUI();
  });
  tlPitchEl.addEventListener('change', function () {
    tlNewMidi = parseInt(tlPitchEl.value, 10);
    if (tlSelected) {
      const arr = tlNotes[tlSelected.ch];
      if (arr && arr[tlSelected.idx]) { arr[tlSelected.idx].midi = tlNewMidi; renderTimelineNotes(); }
    }
  });
  tlClearBtn.addEventListener('click', function () {
    for (let i = 0; i < CHANNELS; i++) tlNotes[i] = [];
    tlSelected = null;
    renderTimelineNotes();
  });
  tlDeleteBtn.addEventListener('click', function () { deleteSelectedNote(); });

  audioImportBtn.addEventListener('click', function () { audioFile.click(); });
  audioFile.addEventListener('change', function () {
    if (audioFile.files && audioFile.files[0]) importAudioFile(audioFile.files[0]);
    audioFile.value = '';
  });
  audioPlayBtn.addEventListener('click', async function () {
    if (!audioLoaded) { showError('请先导入音频文件'); return; }
    await ensureAudioGraph();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (audioEl.paused) {
      audioEl.play().then(function () {
        audioPlaying = true;
        audioPlayBtn.textContent = '⏸ 暂停';
      }).catch(function () {
        audioPlaying = false;
        audioPlayBtn.textContent = '▶ 播放';
        showError('音频播放失败：浏览器可能不支持该格式');
      });
    } else {
      audioEl.pause();
      audioPlaying = false;
      audioPlayBtn.textContent = '▶ 播放';
    }
  });
  audioStopBtn.addEventListener('click', function () {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
    audioPlaying = false;
    audioPlayBtn.textContent = '▶ 播放';
    audioSeek.value = '0';
  });
  audioLoopBtn.addEventListener('click', function () {
    if (!audioEl) return;
    audioEl.loop = !audioEl.loop;
    audioLoopBtn.textContent = '🔁 循环:' + (audioEl.loop ? '开' : '关');
  });
  audioVolEl.addEventListener('input', function () {
    audioVol = parseFloat(audioVolEl.value) / 100;
    audioVolVal.textContent = Math.round(audioVol * 100) + '%';
    if (audioGain && ctx) audioGain.gain.setTargetAtTime(audioVol, ctx.currentTime, 0.02);
  });
  audioSeek.addEventListener('pointerdown', function () { audioSeeking = true; });
  audioSeek.addEventListener('pointerup', function () { audioSeeking = false; });
  audioSeek.addEventListener('change', function () { audioSeeking = false; });
  window.addEventListener('pointerup', function () { audioSeeking = false; });
  window.addEventListener('pointercancel', function () { audioSeeking = false; });
  audioSeek.addEventListener('input', function () {
    if (audioEl && audioEl.duration) {
      audioEl.currentTime = audioEl.duration * parseFloat(audioSeek.value) / 1000;
    }
  });

  seqPlayBtn.addEventListener('click', function () {
    if (!seqRunning) {
      ensureEngine();
      seqRunning = true;
      seqStartWall = performance.now();
      seqPlayBtn.textContent = '❚❚ 停止音序';
      sendSeqState(true);
    } else {
      seqRunning = false;
      lastSeqStep = -1;
      seqPlayBtn.textContent = '▶ 播放音序';
      sendSeqState(false);
    }
  });

  bpmEl.addEventListener('input', function () {
    seqBpm = parseFloat(bpmEl.value);
    bpmVal.textContent = seqBpm + ' BPM';
    sendSeqState(false);
  });

  seqClearBtn.addEventListener('click', function () {
    for (let i = 0; i < 16; i++) {
      seqSteps[i].on = false;
      seqCells[i].classList.remove('on');
    }
    sendSeqState(false);
  });

  seqRandomBtn.addEventListener('click', function () {
    for (let i = 0; i < 16; i++) {
      seqSteps[i].on = Math.random() < 0.5;
      seqSteps[i].midi = PENTA[Math.floor(Math.random() * PENTA.length)];
      seqCells[i].classList.toggle('on', seqSteps[i].on);
    }
    const selects = seqGrid.querySelectorAll('select');
    for (let j = 0; j < selects.length; j++) selects[j].value = String(seqSteps[j].midi);
    sendSeqState(false);
  });

  /* ---------- 初始化 ---------- */
  function init() {
    for (let i = 0; i < CHANNELS; i++) voiceDisplay.push(new Float32Array(512));

    buildVoices();
    initTimeline();
    initAudioPlayer();
    buildSeqGrid();
    buildPiano();
    resizeScope();
    initScopeKnobs();
    window.addEventListener('resize', resizeScope);

    volumeVal.textContent = Math.round(volumeLevel * 100) + '%';
    freqVal.textContent = baseFreq + ' Hz';
    panVal.textContent = '0.00';
    glideVal.textContent = glide + ' ms';
    attackVal.textContent = attackEl.value + ' ms';
    releaseVal.textContent = releaseEl.value + ' ms';
    bpmVal.textContent = seqBpm + ' BPM';
    viewToggle.textContent = '波形';
    syncVoices();
    updatePlayButton();
    draw();
  }

  init();
})();
