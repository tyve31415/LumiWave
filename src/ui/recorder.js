/* =========================================================
   录制与 WAV 导出
   停止录制后编码 WAV，经原生「另存为」对话框保存
   编码在 Web Worker 中进行，不阻塞音频线程
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { ensureCtx, ctx, setRecordingTap } from '../core/engine.js';
import { formatTime } from '../core/util.js';
import { toast } from './toast.js';
import desktop from '../desktop.js';

const MAX_REC_MS = 15 * 60 * 1000;

export const recorderState = {
  recording: false,
  startWall: 0,
  chunks: []
};

function setRecordingFlag(on) {
  recorderState.recording = on;
  desktop.setRecording(on); // 主进程：录音期间退出需确认
}

export function toggleRecording() {
  if (!recorderState.recording) {
    ensureCtx().then(function () {
      if (!ctx) return;
      recorderState.chunks = [];
      setRecordingFlag(true);
      recorderState.startWall = performance.now();
      el.recordBtn.textContent = '■ 停止录制';
      setRecordingTap(true); // 在总输出后采样：录制全部通道的混合结果
    });
  } else {
    stopRecording();
  }
}

export async function stopRecording() {
  if (!recorderState.recording) return;
  setRecordingFlag(false);
  recorderState.startWall = 0;
  el.recordBtn.textContent = '● 录制';
  setRecordingTap(false);
  await exportWav();
}

/** 菜单「导出 WAV」：导出已录制的音频（未录制时提示） */
export async function exportLastRecording() {
  if (!recorderState.chunks.length) {
    toast('尚未录制音频：先点「● 录制」录一段再导出', 'info');
    return;
  }
  await exportWav();
}

/** 每帧更新计时显示与上限保护 */
export function updateRecorder() {
  if (!recorderState.recording || !recorderState.startWall) return;
  el.recordBtn.textContent = '■ 停止录制 ' + formatTime((performance.now() - recorderState.startWall) / 1000);
  if (performance.now() - recorderState.startWall >= MAX_REC_MS) {
    toast('录音已达 ' + Math.round(MAX_REC_MS / 60000) + ' 分钟上限，已自动停止并导出', 'error', 5000);
    stopRecording();
  }
}

/* ---------- WAV 编码 ---------- */
function encodeWavBuffer(samples, sampleRate) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  let off2 = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off2 += 2;
  }
  return buffer;
}

const WAV_WORKER_SRC = [
  'self.onmessage = function (e) {',
  '  var samples = new Float32Array(e.data.samples);',
  '  var sampleRate = e.data.sampleRate;',
  '  var bytesPerSample = 2;',
  '  var buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);',
  '  var view = new DataView(buffer);',
  '  function wstr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }',
  '  wstr(0, "RIFF");',
  '  view.setUint32(4, 36 + samples.length * bytesPerSample, true);',
  '  wstr(8, "WAVE"); wstr(12, "fmt ");',
  '  view.setUint32(16, 16, true);',
  '  view.setUint16(20, 1, true);',
  '  view.setUint16(22, 1, true);',
  '  view.setUint32(24, sampleRate, true);',
  '  view.setUint32(28, sampleRate * 2, true);',
  '  view.setUint16(32, 2, true);',
  '  view.setUint16(34, 16, true);',
  '  wstr(36, "data");',
  '  view.setUint32(40, samples.length * bytesPerSample, true);',
  '  var off = 44;',
  '  for (var i = 0; i < samples.length; i++) {',
  '    var s = samples[i]; if (s > 1) s = 1; else if (s < -1) s = -1;',
  '    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);',
  '    off += 2;',
  '  }',
  '  self.postMessage(buffer, [buffer]);',
  '};'
].join('\n');

function encodeWavAsync(samples, sampleRate) {
  return new Promise(function (resolve, reject) {
    let worker = null;
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([WAV_WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (err) {
      resolve(encodeWavBuffer(samples, sampleRate));
      return;
    }
    worker.onmessage = function (e) {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(e.data);
    };
    worker.onerror = function () {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error('WAV 编码失败'));
    };
    worker.postMessage({ samples: samples.buffer, sampleRate: sampleRate }, [samples.buffer]);
  });
}

async function exportWav() {
  let total = 0;
  recorderState.chunks.forEach(function (c) { total += c.length; });
  if (total === 0) { toast('没有录制到任何音频', 'error'); return; }
  const samples = new Float32Array(total);
  let off = 0;
  recorderState.chunks.forEach(function (c) { samples.set(c, off); off += c.length; });

  try {
    const buffer = await encodeWavAsync(samples, ctx.sampleRate);
    const fileName = 'synth-' + Date.now() + '.wav';

    // 原生「另存为」对话框
    const result = await desktop.saveFile({ data: buffer, suggestedName: fileName });
    if (result && result.ok) {
      toast('已导出：' + result.path, 'success', 5000);
    } else if (result && result.error) {
      toast('导出失败：' + result.error, 'error', 5000);
    } else if (!result) {
      toast('导出失败：保存功能不可用', 'error', 5000);
    }
  } catch (err) {
    toast('导出失败：' + (err && err.message ? err.message : err), 'error', 5000);
  }
}

export function initRecorder() {
  el.recordBtn.addEventListener('click', toggleRecording);
  el.exportWavBtn.addEventListener('click', exportLastRecording);
  // 总输出采样数据 → 录制缓冲
  bus.on('record-samples', function (data) {
    if (recorderState.recording) recorderState.chunks.push(data);
  });
}
