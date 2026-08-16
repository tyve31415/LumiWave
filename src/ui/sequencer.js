/* =========================================================
   步进音序器（16 步 · 五声音阶）—— 独立 CH4 大通道
   使用专属 seqEngine（gateMode=seq-only：仅音序运行时发声）
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { CHANNELS } from '../core/dsp.js';
import { seqEngine } from '../core/engine.js';
import { midiName } from '../core/math.js';

const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93];
const SEQ_LEAD_SRC = 'pulse(TWO_PI * freq * t, 0.25) * 0.22 * env';

export const seqState = {
  running: false,
  bpm: 120,
  steps: [],
  startWall: 0
};

let seqCells = [];
let lastSeqStep = -1;

export function sendSeqState(reset) {
  const steps = seqState.steps.map(function (s) { return { on: s.on, midi: s.midi }; });
  seqEngine.send({ type: 'seq', running: seqState.running, bpm: seqState.bpm, reset: reset, steps: steps });
}

export function stopSequencer() {
  if (!seqState.running) return;
  seqState.running = false;
  lastSeqStep = -1;
  el.seqPlayBtn.textContent = '▶ 播放音序';
  sendSeqState(false);
}

export function toggleSequencer() {
  if (!seqState.running) {
    seqEngine.ensureEngine();
    seqState.running = true;
    seqState.startWall = performance.now();
    el.seqPlayBtn.textContent = '❚❚ 停止音序';
    sendSeqState(true);
  } else {
    stopSequencer();
  }
}

function buildSeqGrid() {
  el.seqGrid.innerHTML = '';
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
      seqState.steps[i].midi = parseInt(sel.value, 10);
      sendSeqState(false);
    });

    const led = document.createElement('div');
    led.className = 'led';
    led.addEventListener('click', function () {
      seqState.steps[i].on = !seqState.steps[i].on;
      led.classList.toggle('on', seqState.steps[i].on);
      sendSeqState(false);
    });

    cell.appendChild(sel);
    cell.appendChild(led);
    el.seqGrid.appendChild(cell);
    seqCells.push(led);
  }
  initSeqSteps();
}

function initSeqSteps() {
  const rhythm = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1];
  seqState.steps = [];
  for (let i = 0; i < 16; i++) {
    seqState.steps.push({ on: rhythm[i] === 1, midi: PENTA[i % PENTA.length] });
    seqCells[i].classList.toggle('on', rhythm[i] === 1);
  }
  const selects = el.seqGrid.querySelectorAll('select');
  for (let j = 0; j < selects.length; j++) selects[j].value = String(seqState.steps[j].midi);
}

function clearSteps() {
  for (let i = 0; i < 16; i++) {
    seqState.steps[i].on = false;
    seqCells[i].classList.remove('on');
  }
  sendSeqState(false);
}

function randomSteps() {
  for (let i = 0; i < 16; i++) {
    seqState.steps[i].on = Math.random() < 0.5;
    seqState.steps[i].midi = PENTA[Math.floor(Math.random() * PENTA.length)];
    seqCells[i].classList.toggle('on', seqState.steps[i].on);
  }
  const selects = el.seqGrid.querySelectorAll('select');
  for (let j = 0; j < selects.length; j++) selects[j].value = String(seqState.steps[j].midi);
  sendSeqState(false);
}

function seqStepIndexDisplay() {
  const durMs = 60 / seqState.bpm / 4 * 1000;
  let i = Math.floor((performance.now() - seqState.startWall) / durMs);
  return ((i % 16) + 16) % 16;
}

/** 每帧更新 LED 高亮 */
export function updateSequencer() {
  if (seqState.running) {
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

export function initSequencer() {
  // 配置 CH4 专属引擎：仅 V1 启用的方波主奏，其余声部关闭
  seqEngine.voices[0] = { enabled: true, gain: 0.6, source: SEQ_LEAD_SRC, error: '' };
  for (let i = 1; i < CHANNELS; i++) {
    seqEngine.voices[i] = { enabled: false, gain: 0.3, source: 'sin(TWO_PI * freq * t) * 0.2 * env', error: '' };
  }
  // 引擎初始化完成后同步一次音序状态
  seqEngine.setSeqProvider(function () { sendSeqState(false); });

  buildSeqGrid();

  el.seqPlayBtn.addEventListener('click', toggleSequencer);
  el.bpm.addEventListener('input', function () {
    seqState.bpm = parseFloat(el.bpm.value);
    el.bpmVal.textContent = seqState.bpm + ' BPM';
    sendSeqState(false);
  });
  el.seqClearBtn.addEventListener('click', clearSteps);
  el.seqRandomBtn.addEventListener('click', randomSteps);
}
