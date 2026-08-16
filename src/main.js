/* =========================================================
   LumiWave · 渲染进程入口（多窗口桌面版）
   装配所有模块、处理系统菜单命令与桌面集成
   ========================================================= */
'use strict';

import { installGlobals } from './core/math.js';
import { bus } from './core/bus.js';
import { el } from './core/dom.js';
import { mainEngine, loadMidiData, toggleDemo, updatePlayButton } from './core/engine.js';
import { initWM } from './ui/wm.js';
import { initChannelUI } from './ui/channels-ui.js';
import { initExplorer } from './ui/explorer.js';
import { initScope, toggleScopeMode } from './ui/scope.js';
import { initMulti } from './ui/multi.js';
import { buildVoices } from './ui/voices.js';
import { initTimeline, initTimelineControls, toggleTimeline, tlState } from './ui/timeline.js';
import { initSequencer, toggleSequencer } from './ui/sequencer.js';
import { buildPiano, initComputerKeyboard } from './ui/piano.js';
import { initAudioPlayerModule, importAudio } from './ui/audio-player.js';
import { initRecorder, toggleRecording, stopRecording, exportLastRecording, recorderState } from './ui/recorder.js';
import { initControls, stopEverything } from './ui/controls.js';
import { startRenderLoop } from './ui/render-loop.js';
import { toast } from './ui/toast.js';
import desktop from './desktop.js';

installGlobals(44100);

/* ---------- 系统菜单命令 ---------- */
function initMenuCommands() {
  // Esc 全局停止（来自琴键处理器）
  bus.on('stop-all', stopEverything);

  if (!desktop.isDesktop) return;
  desktop.onMenuCommand(function (cmd, arg) {
    switch (cmd) {
      case 'open-midi':   // 菜单「导入 MIDI」/ 最近文件
        if (arg && arg.name && arg.data) loadMidiData(arg.name, arg.data);
        break;
      case 'open-audio':  // 菜单「导入音频」/ 最近文件
        if (arg && arg.name && arg.data) importAudio(arg.name, new Blob([arg.data]));
        break;
      case 'toggle-engine':    mainEngine.toggleEngine(); break;
      case 'toggle-demo':      toggleDemo(); break;
      case 'timeline-play':    if (!tlState.playing) toggleTimeline(); break;
      case 'timeline-stop':    if (tlState.playing) toggleTimeline(); break;
      case 'sequencer-toggle': toggleSequencer(); break;
      case 'toggle-record':    toggleRecording(); break;
      case 'toggle-scope':     toggleScopeMode(); break;
      case 'export-wav':
        if (recorderState.recording) stopRecording(); else exportLastRecording();
        break;
      case 'stop-all':         stopEverything(); break;
      default: break;
    }
  });
}

/* ---------- 初始化顺序 ---------- */
function init() {
  initWM();                 // 悬浮窗口管理器（先建立桌面，模块内容才有可见尺寸）
  initChannelUI();          // 通道条 + 示波器图例
  initExplorer();           // 收藏夹窗口
  buildVoices();            // CH1 混音器 16 声部 UI
  initTimeline();
  initTimelineControls();
  initAudioPlayerModule();  // CH3 本地音乐
  initSequencer();          // CH4 音序器
  buildPiano();
  initComputerKeyboard();
  initScope();
  initMulti();
  initControls();
  initRecorder();
  initMenuCommands();

  // 初始读数
  el.volumeVal.textContent = '80%';
  el.freqVal.textContent = '440 Hz';
  el.panVal.textContent = '0.00';
  el.glideVal.textContent = '0 ms';
  el.attackVal.textContent = el.attack.value + ' ms';
  el.releaseVal.textContent = el.release.value + ' ms';
  el.bpmVal.textContent = '120 BPM';
  el.viewToggle.textContent = '波形';

  mainEngine.syncVoices();
  updatePlayButton();
  startRenderLoop();

  toast('固定分屏 · 解锁后拖动可悬浮停靠/磁吸（VS Code 式） · 点击收藏夹音频即播放', 'success', 4000);
}

init();
