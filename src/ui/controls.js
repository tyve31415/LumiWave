/* =========================================================
   混音器（CH1）面板控件：播放/音量/频率/声像/滑音/包络
   + 演示栏 + 拖放导入 + 全局停止
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import {
  ctx, masterGain, panNode, volumeLevel,
  mainEngine, timelineEngine, seqEngine,
  ensureCtx, toggleDemo, playDemoSong, loadMidiData, stopMainSong
} from '../core/engine.js';
import { importAudio, stopAudio } from './audio-player.js';
import { stopSequencer } from './sequencer.js';
import { stopTimeline } from './timeline.js';
import { toast } from './toast.js';
import desktop from '../desktop.js';

/** MIDI 导入（原生文件对话框） */
export async function importMidiFromDialog() {
  const res = await desktop.openFileDialog('midi');
  if (res && res.name && res.data) await loadMidiData(res.name, res.data);
}

/* ---------- 拖放导入 ---------- */
let dragDepth = 0;

function initDragDrop() {
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) {
      // 记录真实路径（桌面版最近文件列表）
      const realPath = desktop.getFilePath(files[0]);
      if (realPath) desktop.addRecentFile(realPath);
      const nm = String(files[0].name || '').toLowerCase();
      if (/\.midi?$/.test(nm)) loadMidiData(files[0].name, files[0]);
      else importAudio(files[0].name, files[0]);
    }
  });
}

export function initControls() {
  el.playBtn.addEventListener('click', function () { mainEngine.toggleEngine(); });
  el.demoBtn.addEventListener('click', toggleDemo);
  el.demoResetBtn.addEventListener('click', playDemoSong);

  el.importBtn.addEventListener('click', importMidiFromDialog);

  // 「应用全部函数」：确保引擎就绪后应用，并给出明确反馈
  el.applyBtn.addEventListener('click', async function () {
    await ensureCtx();   // 引擎尚未创建时先建立（避免发送的消息被丢弃）
    mainEngine.syncVoices();
    const errCount = mainEngine.voices.filter(function (v) { return !!v.error; }).length;
    const enabledCount = mainEngine.voices.filter(function (v) { return v.enabled; }).length;
    if (errCount > 0) {
      toast('已应用：' + enabledCount + ' 个声部启用，' + errCount + ' 个函数有错误（详见声部行红字）', 'error', 4500);
    } else if (enabledCount === 0) {
      toast('已应用 16 个声部函数，但当前没有启用的声部——点行首 V1–V16 按钮启用', 'info', 3800);
    } else {
      toast('已应用 16 个声部函数 · ' + enabledCount + ' 个启用', 'success', 2200);
    }
  });

  el.volume.addEventListener('input', function () {
    volumeLevel = parseFloat(el.volume.value) / 100;
    el.volumeVal.textContent = Math.round(volumeLevel * 100) + '%';
    if (ctx && masterGain) masterGain.gain.setTargetAtTime(volumeLevel, ctx.currentTime, 0.02);
  });

  el.freq.addEventListener('input', function () {
    mainEngine.baseFreq = parseFloat(el.freq.value);
    el.freqVal.textContent = mainEngine.baseFreq + ' Hz';
    mainEngine.send({ type: 'params', baseFreq: mainEngine.baseFreq, attack: mainEngine.attack, release: mainEngine.release, glide: mainEngine.glide });
  });

  el.pan.addEventListener('input', function () {
    const p = parseFloat(el.pan.value);
    el.panVal.textContent = p.toFixed(2);
    if (ctx && panNode) panNode.pan.setTargetAtTime(p, ctx.currentTime, 0.02);
  });

  el.glide.addEventListener('input', function () {
    mainEngine.glide = parseFloat(el.glide.value);
    el.glideVal.textContent = mainEngine.glide + ' ms';
    mainEngine.send({ type: 'params', baseFreq: mainEngine.baseFreq, attack: mainEngine.attack, release: mainEngine.release, glide: mainEngine.glide });
  });

  el.attack.addEventListener('input', function () {
    mainEngine.attack = parseFloat(el.attack.value) / 1000;
    el.attackVal.textContent = el.attack.value + ' ms';
    mainEngine.send({ type: 'params', baseFreq: mainEngine.baseFreq, attack: mainEngine.attack, release: mainEngine.release, glide: mainEngine.glide });
  });

  el.release.addEventListener('input', function () {
    mainEngine.release = parseFloat(el.release.value) / 1000;
    el.releaseVal.textContent = el.release.value + ' ms';
    mainEngine.send({ type: 'params', baseFreq: mainEngine.baseFreq, attack: mainEngine.attack, release: mainEngine.release, glide: mainEngine.glide });
  });

  initDragDrop();
}

/** 菜单「全部停止」：停止全部通道（歌曲/引擎/时间线/音序/音频），释放所有音符 */
export function stopEverything() {
  if (mainEngine.songPlaying && !stopMainSong()) return; // 用户取消还原确认
  if (timelineEngine.songPlaying) stopTimeline();
  mainEngine.stopEngine();
  timelineEngine.stopEngine();
  seqEngine.stopEngine();
  mainEngine.allNotesOff();
  timelineEngine.allNotesOff();
  seqEngine.allNotesOff();
  stopSequencer();
  stopAudio();
}
