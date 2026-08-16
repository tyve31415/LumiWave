/* =========================================================
   多通道示波器：CH1 混音器 16 声部分栏显示（2 列 × 8 行）
   性能优化：辉光以「宽半透明描边」替代 shadowBlur
   画布尺寸跟随窗口（ResizeObserver）
   ========================================================= */
'use strict';

import { el, mctx } from '../core/dom.js';
import { CHANNELS } from '../core/dsp.js';
import { mainEngine } from '../core/engine.js';
import { fitCanvas } from './scope.js';

let mw = 0, mh = 0;

export function resizeMulti() {
  const b = fitCanvas(el.scopeMulti);
  mw = b.w;
  mh = b.h;
}

export function drawMulti() {
  if (!mctx || !mw) return;
  mctx.fillStyle = '#020704';
  mctx.fillRect(0, 0, mw, mh);
  const COLS = 2;
  const ROWS = CHANNELS / COLS;
  const bandH = mh / ROWS;
  const colW = mw / COLS;
  mctx.font = '10px monospace';
  mctx.textBaseline = 'middle';
  mctx.strokeStyle = 'rgba(60,255,136,0.16)';
  mctx.lineWidth = 1;
  mctx.beginPath(); mctx.moveTo(mw / 2, 0); mctx.lineTo(mw / 2, mh); mctx.stroke();

  const voices = mainEngine.voices;
  const voiceDisplay = mainEngine.voiceDisplay;

  for (let v = 0; v < CHANNELS; v++) {
    const col = v < ROWS ? 0 : 1;
    const row = v % ROWS;
    const x0 = col * colW;
    const y0 = row * bandH;
    const mid = y0 + bandH / 2;
    const enabled = voices[v] ? voices[v].enabled : false;

    mctx.strokeStyle = 'rgba(60,255,136,0.10)';
    mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(x0, y0); mctx.lineTo(x0 + colW, y0); mctx.stroke();

    mctx.fillStyle = enabled ? 'rgba(60,255,136,0.85)' : 'rgba(60,255,136,0.28)';
    mctx.fillText('V' + (v + 1), x0 + 8, mid);

    mctx.strokeStyle = enabled ? 'rgba(60,255,136,0.15)' : 'rgba(60,255,136,0.05)';
    mctx.beginPath(); mctx.moveTo(x0 + 44, mid); mctx.lineTo(x0 + colW, mid); mctx.stroke();

    const data = voiceDisplay[v];
    if (data && enabled) {
      const amp = bandH * 0.46;
      const tx0 = x0 + 44, txw = colW - 44 - 6;
      mctx.save();
      mctx.lineCap = 'round';
      mctx.lineJoin = 'round';
      // 第一遍：宽半透明（光晕，替代 shadowBlur）
      mctx.strokeStyle = 'rgba(77,255,154,0.22)';
      mctx.lineWidth = 3.2;
      mctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = tx0 + (i / (data.length - 1)) * txw;
        const y = mid - data[i] * amp;
        if (i === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
      }
      mctx.stroke();
      // 第二遍：细实线
      mctx.strokeStyle = '#4dff9a';
      mctx.lineWidth = 1.4;
      mctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = tx0 + (i / (data.length - 1)) * txw;
        const y = mid - data[i] * amp;
        if (i === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
      }
      mctx.stroke();
      mctx.restore();
    }
  }
}

export function initMulti() {
  resizeMulti();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { resizeMulti(); }).observe(el.scopeMulti);
  } else {
    window.addEventListener('resize', resizeMulti);
  }
}
