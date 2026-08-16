/* =========================================================
   收藏夹窗口（资源管理器样式）
   · 收藏音乐文件夹（持久化），点击即浏览
   · 树形列出文件夹及其子目录下的全部音频文件（惰性展开）
   · 点击音频文件 → 载入 CH3「本地音乐」并播放，主示波器同步显示
   ========================================================= */
'use strict';

import { el } from '../core/dom.js';
import { bus } from '../core/bus.js';
import desktop from '../desktop.js';
import { toast } from './toast.js';
import { setChannelOn } from '../core/channels.js';
import { showWindow } from './wm.js';
import { importAudio, playAudio } from './audio-player.js';

const LAST_DIR_KEY = 'musicExplorerLastDir';

const state = {
  favorites: [],
  currentDir: null,
  expanded: new Set(),
  cache: new Map(),
  playingPath: null
};

function fmtSize(n) {
  if (!isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function dirName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function parentDir(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i <= 1) return s;
  return s.slice(0, i);
}

/* ---------- 收藏夹持久化 ---------- */
async function loadFavorites() {
  if (desktop.isDesktop) {
    try { state.favorites = (await desktop.favoritesGet()) || []; }
    catch (err) { state.favorites = []; }
  } else {
    try { state.favorites = JSON.parse(localStorage.getItem('musicFavorites') || '[]'); }
    catch (err) { state.favorites = []; }
  }
  if (!Array.isArray(state.favorites)) state.favorites = [];
  renderFavorites();
}

async function saveFavorites() {
  if (desktop.isDesktop) {
    try { await desktop.favoritesSave(state.favorites); } catch (err) { /* 忽略 */ }
  } else {
    try { localStorage.setItem('musicFavorites', JSON.stringify(state.favorites)); } catch (err) { /* 忽略 */ }
  }
}

function renderFavorites() {
  el.favList.innerHTML = '';
  if (!state.favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'fav-empty';
    empty.textContent = '暂无收藏 · 点「＋」添加音乐文件夹';
    el.favList.appendChild(empty);
    return;
  }
  for (const f of state.favorites) {
    const row = document.createElement('div');
    row.className = 'fav-item' + (f === state.currentDir ? ' active' : '');
    row.title = f;
    const ic = document.createElement('span');
    ic.className = 'fav-ic';
    ic.textContent = '📁';
    const nm = document.createElement('span');
    nm.className = 'fav-name';
    nm.textContent = dirName(f);
    const del = document.createElement('button');
    del.className = 'fav-del';
    del.textContent = '×';
    del.title = '移除收藏';
    del.addEventListener('click', function (e) { e.stopPropagation(); removeFavorite(f); });
    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(del);
    row.addEventListener('click', function () { openDir(f); });
    el.favList.appendChild(row);
  }
}

async function addFavorite() {
  if (!desktop.isDesktop) { toast('文件夹浏览仅在桌面版可用', 'error'); return; }
  const res = await desktop.openDirectoryDialog();
  if (!res || !res.path) return;
  if (state.favorites.indexOf(res.path) >= 0) {
    toast('该文件夹已在收藏夹中', 'info');
    openDir(res.path);
    return;
  }
  state.favorites.unshift(res.path);
  await saveFavorites();
  renderFavorites();
  openDir(res.path);
}

async function removeFavorite(p) {
  const i = state.favorites.indexOf(p);
  if (i >= 0) state.favorites.splice(i, 1);
  await saveFavorites();
  renderFavorites();
  toast('已移除收藏：' + dirName(p), 'info', 2000);
}

/* ---------- 目录浏览 ---------- */
async function openDir(dir) {
  state.currentDir = dir;
  try { localStorage.setItem(LAST_DIR_KEY, dir); } catch (err) { /* 忽略 */ }
  el.explorerPath.textContent = dir;
  el.explorerPath.title = dir;
  renderFavorites();
  await loadDir(dir);
  renderTree();
}

async function loadDir(dir) {
  if (!desktop.isDesktop) { toast('文件夹浏览仅在桌面版可用', 'error'); return; }
  const res = await desktop.listDir(dir);
  if (res && res.error) {
    toast('无法读取文件夹：' + res.error, 'error', 3200);
    return;
  }
  state.cache.set(dir, res || { dirs: [], files: [] });
}

async function toggleDir(dir) {
  if (state.expanded.has(dir)) {
    state.expanded.delete(dir);
    renderTree();
    return;
  }
  state.expanded.add(dir);
  await loadDir(dir);
  renderTree();
}

function renderTree() {
  const tree = el.explorerTree;
  tree.innerHTML = '';
  const filter = el.explorerFilter.value.trim().toLowerCase();
  if (!state.currentDir) {
    const empty = document.createElement('div');
    empty.className = 'explorer-empty';
    empty.innerHTML = '点击上方收藏夹中的文件夹开始浏览<br>或点「＋」添加音乐文件夹';
    tree.appendChild(empty);
    return;
  }
  buildLevel(state.currentDir, tree, 0, filter);
}

function buildLevel(dir, container, depth, filter) {
  const data = state.cache.get(dir);
  if (!data) return;
  for (const sub of data.dirs) {
    if (filter && sub.name.toLowerCase().indexOf(filter) < 0) continue;
    const row = document.createElement('div');
    const open = state.expanded.has(sub.path);
    row.className = 'ex-row ex-dir' + (open ? ' open' : '');
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    row.title = sub.path;
    const tw = document.createElement('span');
    tw.className = 'ex-tw';
    tw.textContent = open ? '▾' : '▸';
    const ic = document.createElement('span');
    ic.className = 'ex-ic';
    ic.textContent = open ? '📂' : '📁';
    const nm = document.createElement('span');
    nm.className = 'ex-name';
    nm.textContent = sub.name;
    row.appendChild(tw);
    row.appendChild(ic);
    row.appendChild(nm);
    row.addEventListener('click', function () { toggleDir(sub.path); });
    container.appendChild(row);
    if (open) buildLevel(sub.path, container, depth + 1, filter);
  }
  for (const f of data.files) {
    if (filter && f.name.toLowerCase().indexOf(filter) < 0) continue;
    const row = document.createElement('div');
    const playing = f.path === state.playingPath;
    row.className = 'ex-row ex-file' + (playing ? ' playing' : '');
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    row.title = f.path;
    const ic = document.createElement('span');
    ic.className = 'ex-ic';
    ic.textContent = playing ? '▶️' : '🎵';
    const nm = document.createElement('span');
    nm.className = 'ex-name';
    nm.textContent = f.name;
    const sz = document.createElement('span');
    sz.className = 'ex-size';
    sz.textContent = fmtSize(f.size);
    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(sz);
    row.addEventListener('click', function () { playFile(f); });
    container.appendChild(row);
  }
}

/* ---------- 播放文件（点击音频 → 载入 CH3 并播放） ---------- */
async function playFile(f) {
  if (!desktop.isDesktop) { toast('文件读取仅在桌面版可用', 'error'); return; }
  const res = await desktop.readAudioFile(f.path);
  if (!res || res.error) {
    toast('无法读取文件：' + ((res && res.error) || '未知错误'), 'error', 3200);
    return;
  }
  desktop.addRecentFile(f.path);
  setChannelOn('ch3', true);      // 确保 CH3 通道开启
  showWindow('explorer');         // 聚焦「收藏夹 · 本地音乐」合体窗口
  await importAudio(res.name, new Blob([res.data]));
  state.playingPath = f.path;
  renderTree();
  playAudio();
  toast('正在播放：' + res.name, 'info', 2200);
}

function refreshCurrent() {
  if (!state.currentDir) { toast('请先在收藏夹选择文件夹', 'info'); return; }
  loadDir(state.currentDir).then(renderTree);
}

function goUp() {
  if (!state.currentDir) return;
  const p = parentDir(state.currentDir);
  if (p && p !== state.currentDir) openDir(p);
}

/* ---------- 初始化 ---------- */
export function initExplorer() {
  el.favAddBtn.addEventListener('click', addFavorite);
  el.explorerRefreshBtn.addEventListener('click', refreshCurrent);
  el.explorerUpBtn.addEventListener('click', goUp);
  el.explorerFilter.addEventListener('input', renderTree);

  // 音频播放结束 → 清除「正在播放」标记
  bus.on('audio-ended', function () {
    if (state.playingPath) {
      state.playingPath = null;
      renderTree();
    }
  });

  loadFavorites().then(function () {
    if (!state.favorites.length) return;
    let last = null;
    try { last = localStorage.getItem(LAST_DIR_KEY); } catch (err) { /* 忽略 */ }
    if (last && state.favorites.indexOf(last) >= 0) openDir(last);
    else openDir(state.favorites[0]);
  });
}
