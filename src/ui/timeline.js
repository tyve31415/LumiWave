/* =========================================================
   时间线编辑器：16 轨钢琴卷帘（添加 / 拖动 / 拉伸 / 删除音符）
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { CHANNELS } from '../core/dsp.js';
import { timelineEngine } from '../core/engine.js';
import { midiName } from '../core/math.js';

const TL_PX_PER_BEAT = 40;
const TL_HEAD_W = 150;
const TL_ROW_H = 30;
const TL_RULER_H = 22;
const TL_WAVES = [['sq', '方波'], ['tri', '三角波'], ['saw', '锯齿波'], ['pulse', '脉冲波'], ['noise', '噪声']];

export const tlState = {
  notes: [],
  waves: [],
  lanes: [],
  playheadEl: null,
  selected: null,
  bpm: 120,
  bars: 8,
  playing: false,
  starting: false,
  startWall: 0,
  newMidi: 69
};

function tlLanePx() { return tlState.bars * 4 * TL_PX_PER_BEAT; }

export function initTimeline() {
  tlState.notes = [];
  tlState.waves = [];
  tlState.lanes = [];
  for (let i = 0; i < CHANNELS; i++) { tlState.notes.push([]); tlState.waves.push('sq'); }
  el.tlPitch.innerHTML = '';
  for (let m = 36; m <= 96; m++) {
    const o = document.createElement('option');
    o.value = String(m);
    o.textContent = midiName(m);
    if (m === 69) o.selected = true;
    el.tlPitch.appendChild(o);
  }
  buildTimelineUI();
}

function buildTimelineUI() {
  el.tlContent.innerHTML = '';
  tlState.lanes = [];
  tlState.playheadEl = null;

  // 标尺
  const ruler = document.createElement('div');
  ruler.className = 'tl-ruler';
  ruler.style.left = TL_HEAD_W + 'px';
  ruler.style.width = tlLanePx() + 'px';
  ruler.style.height = TL_RULER_H + 'px';
  for (let b = 0; b <= tlState.bars * 4; b++) {
    const mark = document.createElement('span');
    mark.className = 'tl-mark' + (b % 4 === 0 ? ' strong' : '');
    mark.style.left = (b * TL_PX_PER_BEAT) + 'px';
    if (b % 4 === 0) mark.textContent = String(b / 4 + 1);
    ruler.appendChild(mark);
  }
  el.tlContent.appendChild(ruler);

  // 16 条轨道
  for (let i = 0; i < CHANNELS; i++) {
    const row = document.createElement('div');
    row.className = 'tl-track';
    row.style.top = (TL_RULER_H + i * TL_ROW_H) + 'px';
    row.style.height = TL_ROW_H + 'px';

    const head = document.createElement('div');
    head.className = 'tl-head';
    head.style.width = TL_HEAD_W + 'px';
    head.style.height = TL_ROW_H + 'px';
    const lab = document.createElement('span');
    lab.className = 'tl-label';
    lab.textContent = 'V' + (i + 1);
    head.appendChild(lab);
    const sel = document.createElement('select');
    sel.className = 'tl-wave';
    for (let w = 0; w < TL_WAVES.length; w++) {
      const o = document.createElement('option');
      o.value = TL_WAVES[w][0];
      o.textContent = TL_WAVES[w][1];
      if (TL_WAVES[w][0] === tlState.waves[i]) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', (function (ch) { return function () { tlState.waves[ch] = sel.value; }; })(i));
    head.appendChild(sel);
    row.appendChild(head);

    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.style.left = TL_HEAD_W + 'px';
    lane.style.width = tlLanePx() + 'px';
    lane.style.height = TL_ROW_H + 'px';
    lane.addEventListener('pointerdown', (function (ch) {
      return function (e) {
        if (e.target !== lane) return;
        e.preventDefault();
        const rect = lane.getBoundingClientRect();
        const beat = Math.max(0, Math.round((e.clientX - rect.left) / TL_PX_PER_BEAT * 4) / 4);
        tlState.notes[ch].push({ start: beat, dur: 1, midi: tlState.newMidi });
        tlState.selected = null;
        renderTimelineNotes();
      };
    })(i));
    row.appendChild(lane);
    el.tlContent.appendChild(row);
    tlState.lanes.push(lane);
  }

  // 播放头
  const ph = document.createElement('div');
  ph.className = 'tl-playhead';
  ph.style.top = TL_RULER_H + 'px';
  ph.style.height = (CHANNELS * TL_ROW_H) + 'px';
  ph.style.display = 'none';
  el.tlContent.appendChild(ph);
  tlState.playheadEl = ph;

  el.tlContent.style.width = (TL_HEAD_W + tlLanePx() + 20) + 'px';
  el.tlContent.style.height = (TL_RULER_H + CHANNELS * TL_ROW_H) + 'px';
  renderTimelineNotes();
}

function renderTimelineNotes() {
  for (let i = 0; i < CHANNELS; i++) {
    const lane = tlState.lanes[i];
    if (!lane) continue;
    const olds = lane.querySelectorAll('.tl-note');
    for (let k = 0; k < olds.length; k++) olds[k].remove();
    for (let k = 0; k < tlState.notes[i].length; k++) {
      const n = tlState.notes[i][k];
      const div = document.createElement('div');
      const sel = tlState.selected && tlState.selected.ch === i && tlState.selected.idx === k;
      div.className = 'tl-note' + (sel ? ' selected' : '');
      div.style.left = (n.start * TL_PX_PER_BEAT) + 'px';
      div.style.width = Math.max(10, n.dur * TL_PX_PER_BEAT - 2) + 'px';
      div.textContent = midiName(n.midi);
      div.title = midiName(n.midi) + ' · 第' + (n.start + 1).toFixed(2) + '拍 · 长' + n.dur.toFixed(2) + '拍';
      div.addEventListener('pointerdown', (function (ch, idx) { return function (e) { noteMouseDown(ch, idx, e); }; })(i, k));
      lane.appendChild(div);
    }
  }
}

function noteMouseDown(ch, idx, e) {
  e.preventDefault();
  e.stopPropagation();
  const isResize = (e.offsetX >= e.target.offsetWidth - 8);
  selectNote(ch, idx);
  const note = tlState.notes[ch][idx];
  const lane = tlState.lanes[ch];
  const elNote = lane.querySelectorAll('.tl-note')[idx] || e.target;
  const startX = e.clientX;
  const origStart = note.start;
  const origDur = note.dur;
  const maxBeats = tlState.bars * 4;
  try { elNote.setPointerCapture(e.pointerId); } catch (err) {}
  function onMove(ev) {
    const dx = (ev.clientX - startX) / TL_PX_PER_BEAT;
    if (isResize) {
      note.dur = Math.min(maxBeats - note.start, Math.max(0.25, Math.round((origDur + dx) * 4) / 4));
      elNote.style.width = Math.max(10, note.dur * TL_PX_PER_BEAT - 2) + 'px';
    } else {
      note.start = Math.max(0, Math.min(maxBeats - note.dur, Math.round((origStart + dx) * 4) / 4));
      elNote.style.left = (note.start * TL_PX_PER_BEAT) + 'px';
    }
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    renderTimelineNotes();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

function selectNote(ch, idx) {
  tlState.selected = { ch: ch, idx: idx };
  const n = tlState.notes[ch][idx];
  if (n) {
    tlState.newMidi = n.midi;
    el.tlPitch.value = String(n.midi);
  }
  renderTimelineNotes();
}

export function deleteSelectedNote() {
  if (!tlState.selected) return;
  const arr = tlState.notes[tlState.selected.ch];
  if (arr) arr.splice(tlState.selected.idx, 1);
  tlState.selected = null;
  renderTimelineNotes();
}

export function hasSelectedNote() { return !!tlState.selected; }

function makeTimelineVoice(i, wave) {
  const sn = 'S(' + i + ',t)', pn = 'P(' + i + ',t)';
  if (wave === 'noise') return { source: sn + ' ? noise() * exp(-14 * ' + pn + ') * 0.35 : 0', gain: 0.5 };
  let call, amp;
  if (wave === 'tri') { call = 'tri(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.22; }
  else if (wave === 'saw') { call = 'saw(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.16; }
  else if (wave === 'pulse') { call = 'pulse(TWO_PI * ' + sn + ' * ' + pn + ', 0.25)'; amp = 0.14; }
  else { call = 'sq(TWO_PI * ' + sn + ' * ' + pn + ')'; amp = 0.18; }
  return { source: sn + ' ? ' + call + ' * ' + amp + ' : 0', gain: 0.6 };
}

function buildTimelineSong() {
  const ppq = 24;
  const data = [];
  const voices = [];
  for (let i = 0; i < CHANNELS; i++) {
    const flat = [];
    const ns = tlState.notes[i];
    for (let k = 0; k < ns.length; k++) {
      flat.push(Math.round(ns[k].start * ppq), Math.max(1, Math.round(ns[k].dur * ppq)), ns[k].midi);
    }
    data.push(flat);
    voices.push(makeTimelineVoice(i, tlState.waves[i]));
  }
  return { data: data, len: tlState.bars * 4 * ppq, bpm: tlState.bpm, ppq: ppq, voices: voices, name: '时间线' };
}

function setTimelineLock(locked) {
  el.tlBpm.disabled = locked;
  el.tlBars.disabled = locked;
}

export async function playTimeline() {
  tlState.playing = true;
  tlState.starting = true;
  setTimelineLock(true);
  let ok = false;
  try {
    ok = await timelineEngine.startSong(buildTimelineSong());
  } finally {
    tlState.starting = false;
  }
  if (!ok) {
    tlState.playing = false;
    setTimelineLock(false);
    return;
  }
  tlState.startWall = performance.now();
}

export function stopTimeline() {
  if (!timelineEngine.stopSong()) return;
  tlState.playing = false;
  setTimelineLock(false);
  if (tlState.playheadEl) tlState.playheadEl.style.display = 'none';
}

export function toggleTimeline() {
  if (tlState.playing) stopTimeline(); else playTimeline();
}

/** 每帧更新播放头 */
export function updateTimeline() {
  if (!tlState.playing) return;
  if (!timelineEngine.songPlaying) {
    tlState.playing = false;
    setTimelineLock(false);
    if (tlState.playheadEl) tlState.playheadEl.style.display = 'none';
  } else if (tlState.playheadEl && !tlState.starting) {
    const beats = (performance.now() - tlState.startWall) / 1000 * tlState.bpm / 60;
    const pos = (beats % (tlState.bars * 4)) * TL_PX_PER_BEAT;
    tlState.playheadEl.style.display = 'block';
    tlState.playheadEl.style.left = (TL_HEAD_W + pos) + 'px';
  }
}

export function initTimelineControls() {
  el.tlPlayBtn.addEventListener('click', toggleTimeline);
  el.tlStopBtn.addEventListener('click', stopTimeline);
  el.tlBpm.addEventListener('input', function () {
    tlState.bpm = parseFloat(el.tlBpm.value);
    el.tlBpmVal.textContent = tlState.bpm + ' BPM';
  });
  el.tlBars.addEventListener('input', function () {
    tlState.bars = parseFloat(el.tlBars.value);
    el.tlBarsVal.textContent = tlState.bars + ' 小节';
    const maxBeats = tlState.bars * 4;
    for (let i = 0; i < CHANNELS; i++) {
      tlState.notes[i] = tlState.notes[i].filter(function (n) { return n.start + n.dur <= maxBeats + 1e-6; });
    }
    tlState.selected = null;
    buildTimelineUI();
  });
  el.tlPitch.addEventListener('change', function () {
    tlState.newMidi = parseInt(el.tlPitch.value, 10);
    if (tlState.selected) {
      const arr = tlState.notes[tlState.selected.ch];
      if (arr && arr[tlState.selected.idx]) { arr[tlState.selected.idx].midi = tlState.newMidi; renderTimelineNotes(); }
    }
  });
  el.tlClearBtn.addEventListener('click', function () {
    for (let i = 0; i < CHANNELS; i++) tlState.notes[i] = [];
    tlState.selected = null;
    renderTimelineNotes();
  });
  el.tlDeleteBtn.addEventListener('click', deleteSelectedNote);
}
