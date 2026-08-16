/* =========================================================
   集中式 DOM 引用（所有 UI 模块共用，避免重复查询）
   ========================================================= */
'use strict';

function byId(id) { return document.getElementById(id); }

export const el = {
  status: byId('status'),
  scope: byId('scope'),
  scopeMulti: byId('scopeMulti'),
  viewToggle: byId('viewToggle'),
  freqReadout: byId('freqReadout'),

  playBtn: byId('playBtn'),
  demoBtn: byId('demoBtn'),
  demoResetBtn: byId('demoResetBtn'),
  importBtn: byId('importBtn'),

  volume: byId('volume'),
  volumeVal: byId('volumeVal'),
  freq: byId('freq'),
  freqVal: byId('freqVal'),
  pan: byId('pan'),
  panVal: byId('panVal'),
  glide: byId('glide'),
  glideVal: byId('glideVal'),
  attack: byId('attack'),
  attackVal: byId('attackVal'),
  release: byId('release'),
  releaseVal: byId('releaseVal'),

  applyBtn: byId('applyBtn'),
  error: byId('error'),
  voices: byId('voices'),

  seqPlayBtn: byId('seqPlay'),
  bpm: byId('bpm'),
  bpmVal: byId('bpmVal'),
  seqClearBtn: byId('seqClear'),
  seqRandomBtn: byId('seqRandom'),
  seqGrid: byId('seqGrid'),

  piano: byId('piano'),

  recordBtn: byId('recordBtn'),
  exportWavBtn: byId('exportWavBtn'),

  songTitle: byId('songTitle'),
  songSub: byId('songSub'),

  tlPlayBtn: byId('tlPlay'),
  tlStopBtn: byId('tlStop'),
  tlBpm: byId('tlBpm'),
  tlBpmVal: byId('tlBpmVal'),
  tlBars: byId('tlBars'),
  tlBarsVal: byId('tlBarsVal'),
  tlPitch: byId('tlPitch'),
  tlClearBtn: byId('tlClear'),
  tlDeleteBtn: byId('tlDelete'),
  tlContent: byId('tlContent'),

  audioImportBtn: byId('audioImport'),
  audioPlayBtn: byId('audioPlay'),
  audioStopBtn: byId('audioStop'),
  audioLoopBtn: byId('audioLoop'),
  audioVol: byId('audioVol'),
  audioVolVal: byId('audioVolVal'),
  audioSeek: byId('audioSeek'),
  audioTime: byId('audioTime'),
  audioWave: byId('audioWave'),
  audioSpectrum: byId('audioSpectrum'),

  // 收藏夹（资源管理器式）
  favAddBtn: byId('favAddBtn'),
  favList: byId('favList'),
  explorerFilter: byId('explorerFilter'),
  explorerRefreshBtn: byId('explorerRefreshBtn'),
  explorerUpBtn: byId('explorerUpBtn'),
  explorerPath: byId('explorerPath'),
  explorerTree: byId('explorerTree'),

  // 大通道 UI
  channelBar: byId('channelBar'),
  chLegend: byId('chLegend'),

  knobVert: byId('knobVert'),
  knobHoriz: byId('knobHoriz'),
  knobSpecAmp: byId('knobSpecAmp'),
  knobCenter: byId('knobCenter'),
  knobSpan: byId('knobSpan'),
  knobVertVal: byId('knobVertVal'),
  knobHorizVal: byId('knobHorizVal'),
  knobSpecAmpVal: byId('knobSpecAmpVal'),
  knobCenterVal: byId('knobCenterVal'),
  knobSpanVal: byId('knobSpanVal')
};

/** 画布 2D 上下文 */
export const sctx = el.scope.getContext('2d');
export const mctx = el.scopeMulti.getContext('2d');
export const awctx = el.audioWave.getContext('2d');
export const asctx = el.audioSpectrum.getContext('2d');
