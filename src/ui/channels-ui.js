/* =========================================================
   大通道条 UI（通道控制窗口 + 示波器图例）
   · 每个功能模块一条大通道：CH1 混音器 / CH2 时间线 /
     CH3 本地音乐 / CH4 音序器
   · 通道条：开关、合并/独立路由、音量、「窗口」按钮打开模块窗口
   · 示波器 HUD 图例：彩色圆点芯片，点击开关通道
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { CH_DEFS, chState, setChannelOn, cycleChannelRoute, setChannelVol } from '../core/channels.js';
import { showWindow } from './wm.js';

/** 通道 id → 模块窗口 id */
const CH_WIN = { ch1: 'mixer', ch2: 'timeline', ch3: 'music', ch4: 'sequencer' };

function refreshChannelUI() {
  for (const d of CH_DEFS) {
    const s = chState[d.id];

    const strip = el.channelBar.querySelector('[data-ch="' + d.id + '"]');
    if (strip) {
      strip.classList.toggle('off', !s.on);
      strip.classList.toggle('solo', s.route === 'solo');
      const power = strip.querySelector('.ch-power');
      if (power) power.classList.toggle('on', s.on);
      const route = strip.querySelector('.ch-route');
      if (route) route.textContent = s.route === 'mix' ? '⛓ 合并' : '⚡ 独立';
      const vol = strip.querySelector('.ch-vol');
      if (vol && document.activeElement !== vol) vol.value = String(Math.round(s.vol * 100));
      const vv = strip.querySelector('.ch-volval');
      if (vv) vv.textContent = Math.round(s.vol * 100) + '%';
    }

    const chip = el.chLegend.querySelector('[data-ch="' + d.id + '"]');
    if (chip) {
      chip.classList.toggle('off', !s.on);
      chip.classList.toggle('solo', s.route === 'solo');
      chip.title = d.code + ' ' + d.name
        + ' · ' + (s.on ? '开' : '关')
        + ' · ' + (s.route === 'mix' ? '合并到主混音' : '独立监听（SOLO）')
        + ' · ' + Math.round(s.vol * 100) + '%'
        + '\n点击切换开关';
    }
  }
}

function buildStrips() {
  el.channelBar.innerHTML = '';
  el.chLegend.innerHTML = '';

  for (const d of CH_DEFS) {
    /* ---- 通道控制窗口内的通道条 ---- */
    const strip = document.createElement('div');
    strip.className = 'channel-strip';
    strip.dataset.ch = d.id;
    strip.style.setProperty('--chcolor', d.color);

    const power = document.createElement('button');
    power.className = 'ch-power on';
    power.textContent = '●';
    power.title = '通道开关';
    power.addEventListener('click', function () { setChannelOn(d.id, !chState[d.id].on); });

    const title = document.createElement('div');
    title.className = 'ch-title';
    const code = document.createElement('span');
    code.className = 'ch-code';
    code.textContent = d.code;
    const nm = document.createElement('span');
    nm.className = 'ch-name';
    nm.textContent = d.name;
    title.appendChild(code);
    title.appendChild(nm);

    const route = document.createElement('button');
    route.className = 'ch-route';
    route.textContent = '⛓ 合并';
    route.title = '切换 合并 / 独立（独立 = SOLO 单独监听）';
    route.addEventListener('click', function () { cycleChannelRoute(d.id); });

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'ch-vol';
    vol.min = '0';
    vol.max = '100';
    vol.value = String(Math.round(d.vol * 100));
    vol.title = '通道音量';
    vol.addEventListener('input', function () {
      setChannelVol(d.id, parseFloat(vol.value) / 100);
      const vv = strip.querySelector('.ch-volval');
      if (vv) vv.textContent = vol.value + '%';
    });

    const vv = document.createElement('span');
    vv.className = 'ch-volval';
    vv.textContent = Math.round(d.vol * 100) + '%';

    const mb = document.createElement('button');
    mb.className = 'ch-modbtn';
    mb.textContent = '窗口';
    mb.title = '打开/聚焦「' + d.name + '」模块窗口';
    mb.addEventListener('click', function () {
      const winId = CH_WIN[d.id];
      if (winId) showWindow(winId);
    });

    strip.appendChild(power);
    strip.appendChild(title);
    strip.appendChild(route);
    strip.appendChild(vol);
    strip.appendChild(vv);
    strip.appendChild(mb);
    el.channelBar.appendChild(strip);

    /* ---- 示波器 HUD 图例芯片 ---- */
    const chip = document.createElement('button');
    chip.className = 'ch-chip';
    chip.dataset.ch = d.id;
    chip.style.setProperty('--chcolor', d.color);
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = d.code + ' ' + d.name;
    chip.appendChild(dot);
    chip.appendChild(txt);
    chip.addEventListener('click', function () { setChannelOn(d.id, !chState[d.id].on); });
    el.chLegend.appendChild(chip);
  }

  refreshChannelUI();
}

export function initChannelUI() {
  buildStrips();
  bus.on('channels-changed', refreshChannelUI);
}
