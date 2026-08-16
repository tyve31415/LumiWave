/* =========================================================
   钢琴键盘（鼠标 + 电脑键盘）+ 全局快捷键
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { mainEngine } from '../core/engine.js';
import { deleteSelectedNote, hasSelectedNote } from './timeline.js';

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

function bindKey(elKey, midi) {
  elKey.addEventListener('pointerdown', function (e) { e.preventDefault(); mainEngine.noteOn(midi); });
  elKey.addEventListener('pointerenter', function (e) { if (e.buttons & 1) mainEngine.noteOn(midi); });
  elKey.addEventListener('pointerup', function () { mainEngine.noteOff(midi); });
  elKey.addEventListener('pointerleave', function () { mainEngine.noteOff(midi); });
  elKey.addEventListener('pointercancel', function () { mainEngine.noteOff(midi); });
}

function highlightKey(midi, on) {
  const elKey = keyElements[midi];
  if (elKey) elKey.classList.toggle('active', on);
}

export function buildPiano() {
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
    el.piano.appendChild(k);
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
    el.piano.appendChild(k);
    keyElements[midi] = k;
  });
}

/* ---------- 电脑键盘 ---------- */
const pressedKeys = {};

function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable);
}

export function initComputerKeyboard() {
  window.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteSelectedNote(); return; }
    if (e.key === 'Backspace' && hasSelectedNote()) { e.preventDefault(); deleteSelectedNote(); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      mainEngine.toggleEngine();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      bus.emit('stop-all');
      return;
    }
    const k = e.key.toLowerCase();
    if (KEYMAP[k] === undefined) return;
    if (e.repeat || pressedKeys[k]) return;
    pressedKeys[k] = true;
    mainEngine.noteOn(KEYMAP[k]);
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    const k = e.key.toLowerCase();
    if (KEYMAP[k] === undefined) return;
    pressedKeys[k] = false;
    mainEngine.noteOff(KEYMAP[k]);
  });
  window.addEventListener('blur', function () {
    mainEngine.allNotesOff();
    for (const k in pressedKeys) pressedKeys[k] = false;
  });

  // 引擎音符事件 → 琴键高亮（解耦）
  bus.on('key-down', function (midi) { highlightKey(midi, true); });
  bus.on('key-up', function (midi) { highlightKey(midi, false); });
}
