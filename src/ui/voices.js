/* =========================================================
   混音器 UI：16 声部行（开关 / 预设 / 函数 / 增益 / 错误）
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { CHANNELS } from '../core/dsp.js';
import { PRESETS, VOICE_DEFAULTS } from '../core/presets.js';
import { mainEngine, matchPreset } from '../core/engine.js';

export function updateVoiceUI() {
  for (let i = 0; i < mainEngine.voices.length; i++) {
    const v = mainEngine.voices[i];
    if (!v.el) continue;
    v.el.enable.classList.toggle('on', v.enabled);
    v.el.err.textContent = v.error;
  }
}

export function buildVoices() {
  el.voices.innerHTML = '';
  mainEngine.voices.length = 0;
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
    el.voices.appendChild(row);

    const v = { enabled: def.enabled, gain: def.gain / 100, source: def.source, error: '' };
    v.el = { enable: enable, preset: preset, src: src, gain: gain, gval: gval, err: err };
    mainEngine.voices.push(v);

    (function (vi, idx) {
      enable.addEventListener('click', function () {
        vi.enabled = !vi.enabled;
        mainEngine.syncVoices();
      });
      preset.addEventListener('change', function () {
        const p = parseInt(preset.value, 10);
        if (p >= 0 && PRESETS[p]) {
          vi.source = PRESETS[p].code;
          vi.el.src.value = vi.source;
          mainEngine.syncVoices();
        }
      });
      src.addEventListener('input', function () { vi.source = src.value; });
      src.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); mainEngine.syncVoices(); } });
      gain.addEventListener('input', function () {
        vi.gain = parseFloat(gain.value) / 100;
        gval.textContent = gain.value + '%';
        mainEngine.send({ type: 'voice', index: idx, gain: vi.gain, enabled: vi.enabled && !vi.error });
      });
    })(v, i);
  }
  mainEngine.setVoiceUIUpdater(updateVoiceUI);
}
