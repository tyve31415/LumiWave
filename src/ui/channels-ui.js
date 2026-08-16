/* =========================================================
   通道控制 UI（弹出层窗口 + 示波器图例）
   · CH1–CH4 每通道占一行：开关 / 合并·独立 / 音量 / 音源摘要
   · 点击行展开音源面板：勾选该通道由哪些音源相加
     （混音器 / 时间线 / 音乐播放器 / 音序器，多选相加）
   · 手风琴式：同时只展开一行
   · 示波器 HUD 图例：彩色圆点芯片，点击开关通道
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { bus } from '../core/bus.js';
import {
  CH_DEFS, SOURCES, chState,
  setChannelOn, cycleChannelRoute, setChannelVol, setChannelSource, channelSourceSummary
} from '../core/channels.js';

function refreshChannelUI() {
  for (const d of CH_DEFS) {
    const s = chState[d.id];

    const row = el.channelBar.querySelector('[data-ch="' + d.id + '"]');
    if (row) {
      const open = row.classList.contains('open');
      row.classList.toggle('off', !s.on);
      row.classList.toggle('solo', s.route === 'solo');
      const power = row.querySelector('.ch-power');
      if (power) power.classList.toggle('on', s.on);
      const route = row.querySelector('.ch-route');
      if (route) route.textContent = s.route === 'mix' ? '⛓ 合并' : '⚡ 独立';
      const vol = row.querySelector('.ch-vol');
      if (vol && document.activeElement !== vol) vol.value = String(Math.round(s.vol * 100));
      const vv = row.querySelector('.ch-volval');
      if (vv) vv.textContent = Math.round(s.vol * 100) + '%';
      const sum = row.querySelector('.ch-sum');
      if (sum) sum.textContent = channelSourceSummary(d.id);
      const caret = row.querySelector('.ch-caret');
      if (caret) caret.textContent = open ? '▾' : '▸';
      const panel = row.querySelector('.ch-src-panel');
      if (panel) {
        panel.hidden = !open;
        for (const src of SOURCES) {
          const cb = panel.querySelector('[data-src="' + src.id + '"]');
          if (cb) cb.classList.toggle('on', !!s.sources[src.id]);
        }
      }
    }

    const chip = el.chLegend.querySelector('[data-ch="' + d.id + '"]');
    if (chip) {
      chip.classList.toggle('off', !s.on);
      chip.classList.toggle('solo', s.route === 'solo');
      chip.title = d.code
        + ' · ' + (s.on ? '开' : '关')
        + ' · ' + (s.route === 'mix' ? '合并到主混音' : '独立监听（SOLO）')
        + ' · ' + channelSourceSummary(d.id)
        + '\n点击切换开关';
    }
  }
}

function buildChannelList() {
  el.channelBar.innerHTML = '';
  el.chLegend.innerHTML = '';

  for (const d of CH_DEFS) {
    const s = chState[d.id];

    /* ---- 通道行（弹出层窗口内） ---- */
    const row = document.createElement('div');
    row.className = 'channel-row';
    row.dataset.ch = d.id;
    row.style.setProperty('--chcolor', d.color);

    const head = document.createElement('div');
    head.className = 'ch-row-head';
    head.title = '点击展开/收起音源选择';

    const caret = document.createElement('button');
    caret.className = 'ch-caret';
    caret.textContent = '▸';
    caret.title = '展开/收起';

    const power = document.createElement('button');
    power.className = 'ch-power on';
    power.textContent = '●';
    power.title = '通道开关';
    power.addEventListener('click', function (e) {
      e.stopPropagation();
      setChannelOn(d.id, !chState[d.id].on);
    });

    const title = document.createElement('div');
    title.className = 'ch-title';
    const code = document.createElement('span');
    code.className = 'ch-code';
    code.textContent = d.code;
    const sum = document.createElement('span');
    sum.className = 'ch-sum';
    sum.textContent = channelSourceSummary(d.id);
    title.appendChild(code);
    title.appendChild(sum);

    const route = document.createElement('button');
    route.className = 'ch-route';
    route.textContent = '⛓ 合并';
    route.title = '切换 合并 / 独立（独立 = SOLO 单独监听）';
    route.addEventListener('click', function (e) {
      e.stopPropagation();
      cycleChannelRoute(d.id);
    });

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'ch-vol';
    vol.min = '0';
    vol.max = '100';
    vol.value = String(Math.round(s.vol * 100));
    vol.title = '通道音量';
    vol.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    vol.addEventListener('input', function () {
      setChannelVol(d.id, parseFloat(vol.value) / 100);
      const vv = row.querySelector('.ch-volval');
      if (vv) vv.textContent = vol.value + '%';
    });

    const vv = document.createElement('span');
    vv.className = 'ch-volval';
    vv.textContent = Math.round(s.vol * 100) + '%';

    head.appendChild(caret);
    head.appendChild(power);
    head.appendChild(title);
    head.appendChild(route);
    head.appendChild(vol);
    head.appendChild(vv);

    // 手风琴：点击行头展开/收起（同时只展开一行）
    head.addEventListener('click', function () {
      const open = row.classList.contains('open');
      const opened = el.channelBar.querySelectorAll('.channel-row.open');
      for (let i = 0; i < opened.length; i++) opened[i].classList.remove('open');
      if (!open) row.classList.add('open');
      refreshChannelUI();
    });

    /* ---- 展开面板：选择本通道由哪些音源相加 ---- */
    const panel = document.createElement('div');
    panel.className = 'ch-src-panel';
    panel.hidden = true;
    const lab = document.createElement('div');
    lab.className = 'ch-src-title';
    lab.textContent = '本通道 = 所选音源相加：';
    panel.appendChild(lab);
    const grid = document.createElement('div');
    grid.className = 'ch-src-grid';
    for (const src of SOURCES) {
      const cb = document.createElement('button');
      cb.className = 'src-check';
      cb.dataset.src = src.id;
      cb.textContent = src.name;
      cb.title = '勾选后「' + src.name + '」汇入 ' + d.code + '（多选相加）';
      cb.addEventListener('click', function () {
        setChannelSource(d.id, src.id, !chState[d.id].sources[src.id]);
      });
      grid.appendChild(cb);
    }
    panel.appendChild(grid);
    row.appendChild(head);
    row.appendChild(panel);
    el.channelBar.appendChild(row);

    /* ---- 示波器 HUD 图例芯片 ---- */
    const chip = document.createElement('button');
    chip.className = 'ch-chip';
    chip.dataset.ch = d.id;
    chip.style.setProperty('--chcolor', d.color);
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = d.code;
    chip.appendChild(dot);
    chip.appendChild(txt);
    chip.addEventListener('click', function () { setChannelOn(d.id, !chState[d.id].on); });
    el.chLegend.appendChild(chip);
  }

  refreshChannelUI();
}

export function initChannelUI() {
  buildChannelList();
  bus.on('channels-changed', refreshChannelUI);

  // 通道窗口：禁止界面内滚轮滚动（完整界面无需滚动）
  const bodyEl = document.querySelector('.channels-body');
  if (bodyEl) {
    bodyEl.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
  }
}
