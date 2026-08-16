/* =========================================================
   本地音乐播放器（CH3 大通道）：导入 WAV/MP3/FLAC 播放
   · 音频接入 CH3 通道路由（独立示波器 + 合并/独立控制）
   · 收藏夹窗口点击音频文件 → importAudio + playAudio
   ========================================================= */
'use strict';

import { el, awctx, asctx } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { ensureCtx, ctx, showError } from '../core/engine.js';
import { formatTime } from '../core/util.js';
import { fitCanvas } from './scope.js';
import { chState, setChannelOn, setChannelVol, connectChannelSource } from '../core/channels.js';
import desktop from '../desktop.js';

export const audioState = {
  playing: false,
  loaded: false,
  seeking: false,
  w: 0,
  h: 0,
  sw: 0,
  sh: 0
};

let audioEl = null;
let audioSrcNode = null;
let audioAnalyser = null;
let audioWaveData = null;
let audioFreqData = null;

function initAudioPlayer() {
  audioEl = new Audio();
  audioEl.preload = 'metadata';
  audioEl.loop = false;
  audioEl.addEventListener('ended', function () {
    audioState.playing = false;
    el.audioPlayBtn.textContent = '▶ 播放';
    bus.emit('audio-ended');
  });
  audioEl.addEventListener('timeupdate', function () {
    if (audioEl.duration && !audioState.seeking) {
      el.audioSeek.value = String(Math.round(audioEl.currentTime / audioEl.duration * 1000));
      el.audioTime.textContent = formatTime(audioEl.currentTime) + ' / ' + formatTime(audioEl.duration);
    }
  });
  audioEl.addEventListener('loadedmetadata', function () {
    el.audioTime.textContent = '0:00 / ' + formatTime(audioEl.duration);
  });
  audioEl.addEventListener('error', function () {
    if (audioState.loaded) showError('音频加载失败：可能是浏览器不支持的格式');
  });
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
  audioSrcNode.connect(audioAnalyser);
  // 汇入 CH3 大通道（主示波器独立波形 + 合并/独立路由）
  connectChannelSource('ch3', audioAnalyser);
}

/** 导入音频：name + File/Blob */
export async function importAudio(name, blobOrFile) {
  if (!blobOrFile) return;
  const nm = String(name || (blobOrFile.name || '')).toLowerCase();
  if (!/\.(wav|mp3|flac|ogg|m4a|aac|webm)$/.test(nm)) { showError('请选择 WAV / MP3 / FLAC 等音频文件'); return; }
  if (audioState.playing) { audioEl.pause(); audioState.playing = false; el.audioPlayBtn.textContent = '▶ 播放'; }
  const url = URL.createObjectURL(blobOrFile);
  const oldUrl = audioEl.dataset.url;
  audioEl.src = url;
  audioEl.load();
  if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (err) {} }
  audioEl.dataset.url = url;
  audioState.loaded = true;
  setChannelOn('ch3', true);      // 载入即接通 CH3 通道
  await ensureAudioGraph();
  el.audioSeek.value = '0';
  el.audioTime.textContent = '0:00 / 0:00';
  el.status.textContent = '音频 ' + name;
}

/** 原生对话框导入 */
export async function importAudioFromDialog() {
  const res = await desktop.openFileDialog('audio');
  if (res && res.name && res.data) {
    await importAudio(res.name, new Blob([res.data]));
  }
}

/** 播放（收藏夹点击音频后调用） */
export function playAudio() {
  if (!audioState.loaded) { showError('请先导入音频文件'); return; }
  ensureAudioGraph().then(function () {
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (audioEl.paused) {
      audioEl.play().then(function () {
        audioState.playing = true;
        el.audioPlayBtn.textContent = '⏸ 暂停';
      }).catch(function () {
        audioState.playing = false;
        el.audioPlayBtn.textContent = '▶ 播放';
        showError('音频播放失败：浏览器可能不支持该格式');
      });
    }
  });
}

function toggleAudioPlay() {
  if (!audioState.loaded) { showError('请先导入音频文件'); return; }
  if (audioState.playing || !audioEl.paused) {
    audioEl.pause();
    audioState.playing = false;
    el.audioPlayBtn.textContent = '▶ 播放';
  } else {
    playAudio();
  }
}

export function stopAudio() {
  if (!audioEl) return;
  audioEl.pause();
  audioEl.currentTime = 0;
  audioState.playing = false;
  el.audioPlayBtn.textContent = '▶ 播放';
  el.audioSeek.value = '0';
}

/* ---------- 音频示波器绘制（音乐窗口内） ---------- */
function drawAudioScopes() {
  if (!audioAnalyser || !audioState.loaded) return;
  // 波形
  audioAnalyser.getFloatTimeDomainData(audioWaveData);
  awctx.fillStyle = 'rgba(2,7,4,0.24)';
  awctx.fillRect(0, 0, audioState.w, audioState.h);
  awctx.strokeStyle = '#57c8ff';
  awctx.lineWidth = 1.6;
  awctx.beginPath();
  const midW = audioState.h / 2;
  const ampW = audioState.h * 0.42;
  const nW = audioWaveData.length;
  for (let i = 0; i < nW; i++) {
    const x = (i / (nW - 1)) * audioState.w;
    const y = midW - audioWaveData[i] * ampW;
    if (i === 0) awctx.moveTo(x, y); else awctx.lineTo(x, y);
  }
  awctx.stroke();
  // 频谱
  audioAnalyser.getByteFrequencyData(audioFreqData);
  asctx.fillStyle = 'rgba(2,7,4,0.24)';
  asctx.fillRect(0, 0, audioState.sw, audioState.sh);
  asctx.fillStyle = '#57c8ff';
  const nS = Math.min(audioFreqData.length, 160);
  const bw = audioState.sw / nS;
  for (let i = 0; i < nS; i++) {
    const h = (audioFreqData[i] / 255) * audioState.sh * 0.95;
    asctx.fillRect(i * bw, audioState.sh - h, Math.max(1, bw - 1), h);
  }
}

export function drawAudio() {
  if (!audioState.loaded) return;
  drawAudioScopes();
}

export function resizeAudio() {
  const a = fitCanvas(el.audioWave);
  audioState.w = a.w; audioState.h = a.h;
  const b = fitCanvas(el.audioSpectrum);
  audioState.sw = b.w; audioState.sh = b.h;
}

/** 通道条音量与音乐窗口音量双向同步 */
function syncVolFromChannel() {
  const v = Math.round(chState.ch3.vol * 100);
  if (document.activeElement !== el.audioVol) el.audioVol.value = String(v);
  el.audioVolVal.textContent = v + '%';
}

export function initAudioPlayerModule() {
  initAudioPlayer();

  el.audioImportBtn.addEventListener('click', importAudioFromDialog);
  el.audioPlayBtn.addEventListener('click', toggleAudioPlay);
  el.audioStopBtn.addEventListener('click', stopAudio);
  el.audioLoopBtn.addEventListener('click', function () {
    if (!audioEl) return;
    audioEl.loop = !audioEl.loop;
    el.audioLoopBtn.textContent = '🔁 循环:' + (audioEl.loop ? '开' : '关');
  });
  el.audioVol.addEventListener('input', function () {
    setChannelVol('ch3', parseFloat(el.audioVol.value) / 100);
    el.audioVolVal.textContent = el.audioVol.value + '%';
  });
  el.audioSeek.addEventListener('pointerdown', function () { audioState.seeking = true; });
  el.audioSeek.addEventListener('pointerup', function () { audioState.seeking = false; });
  el.audioSeek.addEventListener('change', function () { audioState.seeking = false; });
  window.addEventListener('pointerup', function () { audioState.seeking = false; });
  window.addEventListener('pointercancel', function () { audioState.seeking = false; });
  el.audioSeek.addEventListener('input', function () {
    if (audioEl && audioEl.duration) {
      audioEl.currentTime = audioEl.duration * parseFloat(el.audioSeek.value) / 1000;
    }
  });

  // 通道条 CH3 音量变化 → 同步音乐窗口滑块
  bus.on('channels-changed', syncVolFromChannel);
  syncVolFromChannel();

  resizeAudio();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { resizeAudio(); }).observe(el.audioWave);
  } else {
    window.addEventListener('resize', resizeAudio);
  }
}
