/* =========================================================
   歌曲数据状态与查询函数 S / P
   主线程与 AudioWorklet 各持一份（worklet 由构建器序列化注入）
   ========================================================= */
'use strict';

import {
  SONG_BPM as INITIAL_BPM,
  SONG_PPQ as INITIAL_PPQ,
  SONG_LEN as INITIAL_LEN,
  SONG_DATA as INITIAL_DATA
} from '../data/song-data.js';
import { midiToFreq } from './math.js';

export let SONG_DATA = INITIAL_DATA;
export let SONG_LEN = INITIAL_LEN;
export let SONG_BPM = INITIAL_BPM;
export let SONG_PPQ = INITIAL_PPQ;
export let SONG_TPS = SONG_PPQ * SONG_BPM / 60;

/** 仅更新主线程数据（发给 worklet 由 engine.setSong 负责） */
export function applySong(song) {
  SONG_DATA = song.data || [];
  SONG_LEN = song.len || 7296;
  SONG_BPM = song.bpm || 128;
  SONG_PPQ = song.ppq || 24;
  SONG_TPS = SONG_PPQ * SONG_BPM / 60;
}

export function songSearch(arr, tick) {
  let lo = 0, hi = (arr.length / 3) - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * 3] <= tick) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export function S(ch, t) {
  const arr = SONG_DATA[ch];
  if (!arr || !arr.length) return 0;
  let tick = (t * SONG_TPS) % SONG_LEN;
  if (tick < 0) tick += SONG_LEN;
  const idx = songSearch(arr, tick);
  if (idx < 0) return 0;
  if (tick >= arr[idx * 3] + arr[idx * 3 + 1]) return 0;
  return midiToFreq(arr[idx * 3 + 2]);
}

export function P(ch, t) {
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
