/* =========================================================
   中央渲染循环
   性能优化：
   1. 页面隐藏（最小化/切后台）时完全停止绘制工作
   2. 空闲时低频刷新（磷光余晖衰减仍可见），活跃时全速
   3. 汇总「活跃」状态同步给主进程防 CPU 节流
   ========================================================= */
'use strict';

import { mainEngine, timelineEngine, seqEngine } from '../core/engine.js';
import { seqState } from './sequencer.js';
import { tlState } from './timeline.js';
import { recorderState } from './recorder.js';
import { audioState } from './audio-player.js';
import { drawScope, updateFreqReadout } from './scope.js';
import { drawMulti } from './multi.js';
import { updateSequencer } from './sequencer.js';
import { updateTimeline } from './timeline.js';
import { updateRecorder } from './recorder.js';
import { drawAudio } from './audio-player.js';
import desktop from '../desktop.js';

let frameNo = 0;
let lastActive = null;

/** 是否有任何音频/动画源在活跃运行 */
function isActive() {
  return mainEngine.running || timelineEngine.running || seqEngine.running
    || audioState.playing || recorderState.recording || seqState.running || tlState.playing;
}

function syncDesktopActive(active) {
  if (active !== lastActive) {
    lastActive = active;
    desktop.setActive(active);
  }
}

function frame() {
  requestAnimationFrame(frame);
  // 页面隐藏时不做绘制工作（Electron 关闭了后台节流，需主动跳过）；
  // 但保持活跃状态同步 —— 音频播放中仍需防系统挂起
  if (document.hidden) { syncDesktopActive(isActive()); return; }
  frameNo++;
  const active = isActive();
  syncDesktopActive(active);

  const drawNow = active || frameNo % 24 === 0;
  if (drawNow) {
    drawScope();
    if ((frameNo & 1) === 0) drawMulti();
    drawAudio();
  }
  updateFreqReadout();
  updateRecorder();
  updateTimeline();
  updateSequencer();
}

export function startRenderLoop() {
  requestAnimationFrame(frame);
}
