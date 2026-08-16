/* =========================================================
   MIDI 文件解析与自动分析（导入 .mid 并分配 16 声部）
   ========================================================= */
'use strict';

const DRUM_KICK = [35, 36];
const DRUM_SNARE = [37, 38, 40];
const DRUM_HAT = [42, 44, 46, 54];
const DRUM_CYMBAL = [49, 51, 52, 53, 55, 57, 59];

function readVarLen(view, pos) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (pos >= view.byteLength) throw new Error('MIDI 文件损坏（变长数值越界）');
    const b = view.getUint8(pos++);
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [value, pos];
  }
  throw new Error('MIDI 文件损坏（变长数值过长）');
}

export function parseMidi(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 14) throw new Error('文件太小');
  const hdr = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (hdr !== 'MThd') throw new Error('不是有效的 MIDI 文件');
  const hdrLen = view.getUint32(4);
  const format = view.getUint16(8);
  const ntrks = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('不支持 SMPTE 时间码');
  const ppq = division;

  let pos = 8 + hdrLen;
  const tempos = [];
  const timeSigs = [];
  const notes = [];

  for (let t = 0; t < ntrks; t++) {
    if (pos + 8 > view.byteLength) break;
    const tLen = view.getUint32(pos + 4);
    pos += 8;
    const trackEnd = Math.min(pos + tLen, view.byteLength);
    let absTick = 0;
    let runningStatus = null;
    const raw = [];

    while (pos < trackEnd) {
      const rv = readVarLen(view, pos);
      absTick += rv[0]; pos = rv[1];
      let status = view.getUint8(pos);
      if (status === 0xFF) {
        pos++;
        const type = view.getUint8(pos++);
        const rl = readVarLen(view, pos); pos = rl[1];
        const ds = pos; pos += rl[0];
        if (type === 0x51 && rl[0] >= 3) {
          const us = (view.getUint8(ds) << 16) | (view.getUint8(ds + 1) << 8) | view.getUint8(ds + 2);
          tempos.push({ tick: absTick, bpm: Math.round(60000000 / us) });
        } else if (type === 0x58 && rl[0] >= 2) {
          timeSigs.push({ tick: absTick, num: view.getUint8(ds), den: Math.pow(2, view.getUint8(ds + 1)) });
        }
      } else if (status === 0xF0 || status === 0xF7) {
        const rl = readVarLen(view, pos + 1);
        pos = rl[1] + rl[0];
      } else if (status === 0xF1 || status === 0xF3) {
        pos += 1;
      } else if (status === 0xF2) {
        pos += 2;
      } else if (status >= 0xF4 && status <= 0xFE) {
        // 系统公共/实时消息（无数据字节）
      } else {
        if (status < 0x80) {
          status = runningStatus;
        } else {
          pos++;
          runningStatus = status;
        }
        if (status == null) break;
        const type = status & 0xF0;
        const ch = status & 0x0F;
        if (type === 0x80 || type === 0x90) {
          const note = view.getUint8(pos++);
          const vel = view.getUint8(pos++);
          raw.push({ tick: absTick, ch: ch, note: note, vel: vel, on: (type === 0x90 && vel > 0) });
        } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) { pos += 2; }
        else if (type === 0xC0 || type === 0xD0) { pos += 1; }
      }
    }

    const open = {};
    for (let k = 0; k < raw.length; k++) {
      const ev = raw[k];
      const key = ev.ch + ':' + ev.note;
      if (ev.on) {
        if (open[key]) notes.push({ tick: open[key].tick, dur: ev.tick - open[key].tick, ch: ev.ch, note: ev.note, vel: open[key].vel });
        open[key] = { tick: ev.tick, vel: ev.vel };
      } else {
        if (open[key]) { notes.push({ tick: open[key].tick, dur: ev.tick - open[key].tick, ch: ev.ch, note: ev.note, vel: open[key].vel }); delete open[key]; }
      }
    }
    pos = trackEnd;
  }

  return { format: format, ntrks: ntrks, ppq: ppq, tempos: tempos, timeSigs: timeSigs, notes: notes };
}

function gateForRole(role, ppq) {
  if (role === 'hat') return Math.max(2, Math.round(ppq / 8));
  if (role === 'cymbal') return ppq;
  return Math.round(ppq / 4);
}

function makeVoice(i, role, avgNote) {
  const sn = 'S(' + i + ',t)', pn = 'P(' + i + ',t)';
  if (role === 'kick') return { source: sn + ' ? noise() * exp(-20 * ' + pn + ') * 0.7 : 0', gain: 0.85 };
  if (role === 'snare') return { source: sn + ' ? (noise() * 0.6 + sin(TWO_PI * 180 * ' + pn + ') * 0.4) * exp(-15 * ' + pn + ') * 0.4 : 0', gain: 0.5 };
  if (role === 'hat') return { source: sn + ' ? noise() * exp(-70 * ' + pn + ') * 0.25 : 0', gain: 0.3 };
  if (role === 'cymbal') return { source: sn + ' ? noise() * exp(-12 * ' + pn + ') * 0.3 : 0', gain: 0.4 };
  if (role === 'perc') return { source: sn + ' ? noise() * exp(-30 * ' + pn + ') * 0.4 : 0', gain: 0.5 };
  if (avgNote < 48) return { source: sn + ' ? tri(TWO_PI * ' + sn + ' * ' + pn + ') * 0.28 : 0', gain: 0.6 };
  if (avgNote >= 64) return { source: sn + ' ? sq(TWO_PI * ' + sn + ' * ' + pn + ') * 0.13 : 0', gain: 0.65 };
  return { source: sn + ' ? sq(TWO_PI * ' + sn + ' * ' + pn + ') * 0.16 : 0', gain: 0.6 };
}

export function analyzeMidi(parsed, fileName) {
  const ppq = parsed.ppq;
  const notes = parsed.notes;
  if (!notes || !notes.length) return null;
  const bpm = parsed.tempos.length ? parsed.tempos[0].bpm : 120;
  const ts = parsed.timeSigs.length ? parsed.timeSigs[0] : { num: 4, den: 4 };
  const ticksPerBar = ppq * ts.num * 4 / Math.max(1, ts.den);

  const byCh = {};
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    (byCh[n.ch] = byCh[n.ch] || []).push(n);
  }

  const songChannels = [];
  const chList = Object.keys(byCh).map(Number).sort(function (a, b) { return a - b; });
  for (let ci = 0; ci < chList.length && songChannels.length < 16; ci++) {
    const ch = chList[ci];
    const chNotes = byCh[ch].slice().sort(function (a, b) { return a.tick - b.tick; });
    const uniq = new Set(chNotes.map(function (n) { return n.note; }));
    const isDrum = (ch === 9) || (uniq.size <= 8 && Array.from(uniq).every(function (m) { return m >= 30 && m <= 62; }));
    if (isDrum) {
      const groups = { kick: [], snare: [], hat: [], cymbal: [], perc: [] };
      for (let i = 0; i < chNotes.length; i++) {
        const n = chNotes[i];
        let g = 'perc';
        if (DRUM_KICK.indexOf(n.note) >= 0) g = 'kick';
        else if (DRUM_SNARE.indexOf(n.note) >= 0) g = 'snare';
        else if (DRUM_HAT.indexOf(n.note) >= 0) g = 'hat';
        else if (DRUM_CYMBAL.indexOf(n.note) >= 0) g = 'cymbal';
        groups[g].push(n);
      }
      const order = ['kick', 'snare', 'hat', 'cymbal', 'perc'];
      for (let gi = 0; gi < order.length && songChannels.length < 16; gi++) {
        if (groups[order[gi]].length) songChannels.push({ role: order[gi], events: groups[order[gi]] });
      }
    } else {
      let sum = 0;
      for (let i = 0; i < chNotes.length; i++) sum += chNotes[i].note;
      songChannels.push({ role: 'melodic', events: chNotes, avgNote: sum / chNotes.length });
    }
  }

  const data = [];
  const voices = [];
  let maxEnd = 0;
  for (let i = 0; i < songChannels.length; i++) {
    const sc = songChannels[i];
    const flat = [];
    for (let k = 0; k < sc.events.length; k++) {
      const n = sc.events[k];
      let dur = Math.max(1, Math.round(n.dur));
      if (sc.role !== 'melodic') dur = gateForRole(sc.role, ppq);
      flat.push(n.tick, dur, n.note);
      if (n.tick + dur > maxEnd) maxEnd = n.tick + dur;
    }
    data.push(flat);
    voices.push(makeVoice(i, sc.role, sc.avgNote || 60));
  }

  const len = Math.ceil(maxEnd / ticksPerBar) * ticksPerBar;
  return { data: data, len: len, bpm: bpm, ppq: ppq, voices: voices, name: String(fileName || '导入的歌曲').replace(/\.midi?$/i, '') };
}
