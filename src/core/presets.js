/* =========================================================
   波形预设、默认声部、内置演示曲声部定义
   ========================================================= */
'use strict';

import { SONG_DATA as DEMO_DATA, SONG_LEN as DEMO_LEN, SONG_BPM as DEMO_BPM, SONG_PPQ as DEMO_PPQ } from '../data/song-data.js';

export const PRESETS = [
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

export const VOICE_DEFAULTS = [
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
export const DEMO_VOICES = [
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

export function createDemoSong() {
  return {
    name: 'Funky Stars',
    bpm: DEMO_BPM,
    ppq: DEMO_PPQ,
    data: DEMO_DATA,
    len: DEMO_LEN,
    voices: DEMO_VOICES
  };
}
