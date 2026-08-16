/* =========================================================
   VS Code 式分屏窗口管理器（固定布局 + 锁定 + 悬浮拖动 + 停靠）
   · 每个窗口有预设槽位（默认位置 + 大小），窗口不重叠、不堆叠
   · 「收藏夹 · 本地音乐」合体窗口为固定栏（最左列）：位置大小恒定，
     禁止拖动/缩放/停靠，无锁按钮；步进音序器位于最右列（可自由调整）
   · 「通道控制」为弹出层：顶栏「窗口」菜单打开，悬浮覆盖在其他窗口之上，
     可自由拖动（位置记忆），无锁按钮，禁止缩放，不参与分屏与障碍计算，
     点击窗口外自动收起
   · 顶栏导航：窗口按钮合并为「🪟 窗口」下拉菜单（由 WIN_DEFS 生成），
     含各窗口状态指示与「▦ 整理」入口
   · 右上角「锁定」按钮：锁定=禁止移动/缩放（默认）；解锁后可调整
   · 拖动（参考 VS Code）：
     - 拖动中窗口抬升到最上层并半透明，可【暂时悬浮在其他窗口之上】
     - 悬停到其他窗口 → 显示四边分屏停靠高亮（左/右/上/下半区）
     - 松开 → 停靠分屏：目标窗口让出半区，两者平分其原区域
     - 空白处 → 磁吸吸引（对齐其他窗口边缘 / 桌面边缘），预览框提示
     - 落点非法（与其他窗口重叠）→ 弹回原位
   · 缩放：八向缩放 + 磁吸对齐；停靠对共享边界双向联动——
     拖动边界会同时调整两侧窗口尺寸（VS Code 分割条行为）
   · 停靠关系随目标移动/缩放自动重排；拖离即解除停靠
   · 位置/大小/锁定/停靠/可见状态持久化；「▦ 整理」恢复默认分屏
   ========================================================= */
'use strict';

import { bus } from '../core/bus.js';

const BASE_W = 1536;
const BASE_H = 800;
const GAP = 6;     // 窗口间隙
const SNAP = 12;   // 磁吸距离
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const DOCK_SIDE_LABEL = { right: '▶', left: '◀', bottom: '▼', top: '▲' };

/* fixed: 固定栏 —— 位置/大小锁定，禁止拖动、缩放与停靠（该窗口无锁按钮）
   收藏夹与本地音乐已合并为「explorer」一个窗口；步进音序器与其交换位置（最右列）
   popup: 弹出层 —— 由顶栏按钮打开，悬浮覆盖在其他窗口之上（无锁按钮、不参与分屏、
   点击窗口外自动收起，默认隐藏） */
const WIN_DEFS = [
  { id: 'explorer',  title: '🗂 收藏夹 · 本地音乐', short: '收藏夹', x: 10,   y: 10,  w: 336, h: 780, minW: 300, minH: 400, fixed: true },
  { id: 'channels',  title: '🎛 通道控制',          short: '通道',   x: 408,  y: 48,  w: 720, h: 300, minW: 460, minH: 100, popup: true },
  { id: 'scope',     title: '◉ 主示波器',          short: '示波器', x: 356,  y: 10,  w: 824, h: 400, minW: 380, minH: 240 },
  { id: 'mixer',     title: '🎹 混音器 · CH1',      short: '混音器', x: 356,  y: 420, w: 450, h: 370, minW: 380, minH: 240 },
  { id: 'timeline',  title: '🕘 时间线 · CH2',      short: '时间线', x: 816,  y: 420, w: 364, h: 370, minW: 320, minH: 200 },
  { id: 'sequencer', title: '🔢 步进音序器 · CH4',  short: '音序器', x: 1190, y: 10,  w: 336, h: 780, minW: 324, minH: 190 }
];

/* v4：通道控制改为顶栏弹出层（不再占分屏格位），混音器/时间线上移补齐空白 */
const SAVE_KEY = 'musicWinLayout4';

const winState = new Map();
let focusedId = null;
let desktopEl = null;
let innerEl = null;
let canvasW = BASE_W;
let canvasH = BASE_H;
let saveTimer = null;
let dockEl = null;   // 停靠分屏预览
let snapEl = null;   // 磁吸/桌面吸附预览

/* ---------- 持久化 ---------- */
function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (err) { return {}; }
}

function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLayout, 300);
}

function saveLayout() {
  const out = {};
  for (const st of winState.values()) {
    out[st.def.id] = {
      x: st.rect.x, y: st.rect.y, w: st.rect.w, h: st.rect.h,
      visible: st.visible,
      locked: st.locked,
      dock: st.dock ? { targetId: st.dock.targetId, side: st.dock.side } : null
    };
  }
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(out)); } catch (err) { /* 忽略 */ }
}

function applyRect(st) {
  st.el.style.left = st.rect.x + 'px';
  st.el.style.top = st.rect.y + 'px';
  st.el.style.width = st.rect.w + 'px';
  st.el.style.height = st.rect.h + 'px';
}

function clampRect(st) {
  st.rect.w = Math.max(st.def.minW, Math.min(st.rect.w, canvasW - 4));
  st.rect.h = Math.max(st.def.minH, Math.min(st.rect.h, canvasH - 4));
  st.rect.x = Math.max(-st.rect.w + 70, Math.min(canvasW - 70, st.rect.x));
  st.rect.y = Math.max(0, Math.min(canvasH - 26, st.rect.y));
}

/* ---------- 画布 ---------- */
function computeCanvas() {
  if (!desktopEl || !innerEl) return;
  const dw = desktopEl.clientWidth;
  const dh = desktopEl.clientHeight;
  const nw = Math.max(dw, BASE_W);
  const nh = Math.max(dh, BASE_H);
  const sx = nw / canvasW;
  const sy = nh / canvasH;
  innerEl.style.width = nw + 'px';
  innerEl.style.height = nh + 'px';
  if (sx !== 1 || sy !== 1) {
    for (const st of winState.values()) {
      st.rect.x *= sx;
      st.rect.y *= sy;
      st.rect.w *= sx;
      st.rect.h *= sy;
      applyRect(st);
    }
  }
  canvasW = nw;
  canvasH = nh;
}

function defaultRect(def) {
  const sx = canvasW / BASE_W;
  const sy = canvasH / BASE_H;
  return { x: def.x * sx, y: def.y * sy, w: def.w * sx, h: def.h * sy };
}

/* ---------- 停靠关系 ---------- */
function isDockLinked(aId, bId) {
  const a = winState.get(aId);
  const b = winState.get(bId);
  return !!(a && b && ((a.dock && a.dock.targetId === bId) || (b.dock && b.dock.targetId === aId)));
}

/** 障碍：其他可见窗口（停靠联动对与弹出层除外） */
function obstaclesFor(excludeId) {
  const out = [];
  for (const st of winState.values()) {
    if (st.def.id === excludeId || !st.visible || st.def.popup) continue;
    if (isDockLinked(excludeId, st.def.id)) continue;
    out.push({
      x: st.rect.x - GAP,
      y: st.rect.y - GAP,
      w: st.rect.w + GAP * 2,
      h: st.rect.h + GAP * 2
    });
  }
  return out;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isRectValid(excludeId, r) {
  if (r.x < 0 || r.y < 0 || r.x + r.w > canvasW + 0.5 || r.y + r.h > canvasH + 0.5) return false;
  const obs = obstaclesFor(excludeId);
  for (let i = 0; i < obs.length; i++) {
    if (rectsOverlap(r, obs[i])) return false;
  }
  return true;
}

function findFreeRect(excludeId, prefer) {
  if (prefer && isRectValid(excludeId, prefer)) return prefer;
  if (!prefer || !prefer.w || !prefer.h) return null;
  for (let y = 0; y + prefer.h <= canvasH; y += 16) {
    for (let x = 0; x + prefer.w <= canvasW; x += 16) {
      const r = { x: x, y: y, w: prefer.w, h: prefer.h };
      if (isRectValid(excludeId, r)) return r;
    }
  }
  return null;
}

/** 目标窗口移动 → 停靠窗口整体平移；目标缩放 → 内边跟随、外边固定 */
function updateFollowers(moved, dx, dy) {
  for (const st of winState.values()) {
    if (!st.visible || !st.dock || st.dock.targetId !== moved.def.id) continue;
    const T = moved.rect;
    let nx, ny, nw, nh;
    if (dx !== undefined) {
      nx = st.rect.x + dx;
      ny = st.rect.y + dy;
      nw = st.rect.w;
      nh = st.rect.h;
    } else {
      const outer = st.rect;
      switch (st.dock.side) {
        case 'right':
          nx = T.x + T.w + GAP; ny = T.y; nh = T.h;
          nw = Math.max(st.def.minW, (outer.x + outer.w) - nx);
          break;
        case 'left':
          nw = Math.max(st.def.minW, (T.x - GAP) - outer.x);
          nx = T.x - GAP - nw; ny = T.y; nh = T.h;
          break;
        case 'bottom':
          ny = T.y + T.h + GAP; nx = T.x; nw = T.w;
          nh = Math.max(st.def.minH, (outer.y + outer.h) - ny);
          break;
        case 'top':
          nh = Math.max(st.def.minH, (T.y - GAP) - outer.y);
          ny = T.y - GAP - nh; nx = T.x; nw = T.w;
          break;
      }
    }
    st.rect = { x: nx, y: ny, w: nw, h: nh };
    clampRect(st);
    applyRect(st);
  }
}

/** 停靠窗口缩放共享边界 → 反向调整目标窗口（VS Code 分割条） */
function syncBoundary(st) {
  if (!st.dock) return;
  const T = winState.get(st.dock.targetId);
  if (!T || !T.visible) return;
  switch (st.dock.side) {
    case 'right': {  // st 在 T 右侧，共享边 = st 左 / T 右
      const nw = st.rect.x - GAP - T.rect.x;
      if (nw >= T.def.minW) { T.rect.w = nw; applyRect(T); }
      break;
    }
    case 'left': {   // st 在 T 左侧，共享边 = st 右 / T 左
      const nx = st.rect.x + st.rect.w + GAP;
      const nw = (T.rect.x + T.rect.w) - nx;
      if (nw >= T.def.minW) { T.rect.x = nx; T.rect.w = nw; applyRect(T); }
      break;
    }
    case 'bottom': { // st 在 T 下方，共享边 = st 上 / T 下
      const nh = st.rect.y - GAP - T.rect.y;
      if (nh >= T.def.minH) { T.rect.h = nh; applyRect(T); }
      break;
    }
    case 'top': {    // st 在 T 上方，共享边 = st 下 / T 上
      const ny = st.rect.y + st.rect.h + GAP;
      const nh = (T.rect.y + T.rect.h) - ny;
      if (nh >= T.def.minH) { T.rect.y = ny; T.rect.h = nh; applyRect(T); }
      break;
    }
  }
}

function refreshDockBadges() {
  for (const st of winState.values()) {
    let badge = st.el.querySelector('.dock-badge');
    const docked = !!st.dock;
    st.el.classList.toggle('docked', docked);
    if (docked) {
      const target = winState.get(st.dock.targetId);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'dock-badge';
        const bar = st.el.querySelector('.win-bar');
        bar.insertBefore(badge, bar.querySelector('.win-btn'));
      }
      badge.textContent = '⧉' + DOCK_SIDE_LABEL[st.dock.side] + (target ? target.def.short : '');
      badge.title = '已停靠到「' + (target ? target.def.short : '') + '」' + DOCK_SIDE_LABEL[st.dock.side] + '侧 · 拖动本窗口可解除停靠';
    } else if (badge) {
      badge.remove();
    }
  }
}

/** 停靠分屏：把 st 停靠到 target 的 side 半区，两者平分原区域 */
function dockInto(st, target, side) {
  if (isDockLinked(st.def.id, target.def.id)) return false;
  const T = target.rect;
  const halfW = (T.w - GAP) / 2;
  const halfH = (T.h - GAP) / 2;
  if (side === 'right' || side === 'left') {
    if (halfW < st.def.minW || halfW < target.def.minW || T.h < st.def.minH) return false;
    if (side === 'right') {
      target.rect.w = halfW;
      st.rect = { x: T.x + halfW + GAP, y: T.y, w: halfW, h: T.h };
    } else {
      st.rect = { x: T.x, y: T.y, w: halfW, h: T.h };
      target.rect.x = T.x + halfW + GAP;
      target.rect.w = halfW;
    }
  } else {
    if (halfH < st.def.minH || halfH < target.def.minH || T.w < st.def.minW) return false;
    if (side === 'bottom') {
      target.rect.h = halfH;
      st.rect = { x: T.x, y: T.y + halfH + GAP, w: T.w, h: halfH };
    } else {
      st.rect = { x: T.x, y: T.y, w: T.w, h: halfH };
      target.rect.y = T.y + halfH + GAP;
      target.rect.h = halfH;
    }
  }
  st.dock = { targetId: target.def.id, side: side };
  applyRect(st);
  applyRect(target);
  updateFollowers(st);
  refreshDockBadges();
  return true;
}

/* ---------- 焦点 / 显示 / 任务栏 ---------- */
function focus(st) {
  if (focusedId === st.def.id && st.el.classList.contains('focused')) return;
  for (const other of winState.values()) {
    other.focused = false;
    other.el.classList.remove('focused');
  }
  st.focused = true;
  focusedId = st.def.id;
  st.el.classList.add('focused');
  refreshTaskbar();
}

/* ---------- 顶栏「🪟 窗口」下拉菜单（由 WIN_DEFS 生成） ---------- */
let menuOpen = false;

function refreshTaskbar() {
  const items = document.querySelectorAll('.win-menu-item[data-task]');
  for (const item of items) {
    const st = winState.get(item.dataset.task);
    if (!st) continue;
    item.classList.toggle('open', st.visible);
    item.classList.toggle('focused', st.visible && st.focused);
  }
}

function setWinMenu(open) {
  menuOpen = !!open;
  const list = document.getElementById('winMenuList');
  const btn = document.getElementById('winMenuBtn');
  if (list) list.hidden = !menuOpen;
  if (btn) {
    btn.classList.toggle('active', menuOpen);
    btn.setAttribute('aria-expanded', String(menuOpen));
  }
  if (menuOpen) refreshTaskbar();
}

function wireTaskbar() {
  const list = document.getElementById('winMenuList');
  const btn = document.getElementById('winMenuBtn');
  if (!list || !btn) return;
  // 窗口条目由 WIN_DEFS 生成（单一数据源），带打开/聚焦状态指示
  for (const def of WIN_DEFS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'win-menu-item';
    item.dataset.task = def.id;
    const dot = document.createElement('span');
    dot.className = 'mi-state';
    const title = document.createElement('span');
    title.className = 'mi-title';
    title.textContent = def.title;
    item.appendChild(dot);
    item.appendChild(title);
    item.title = '打开/聚焦「' + def.title + '」';
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      const st = winState.get(def.id);
      if (st) toggle(st);
      refreshTaskbar();
      setWinMenu(false);
    });
    list.appendChild(item);
  }
  const sep = document.createElement('div');
  sep.className = 'win-menu-sep';
  list.appendChild(sep);
  const arr = document.createElement('button');
  arr.type = 'button';
  arr.className = 'win-menu-item win-menu-arrange';
  arr.textContent = '▦ 整理全部窗口';
  arr.title = '重新显示全部窗口并恢复默认分屏布局（弹出层收起）';
  arr.addEventListener('click', function (e) {
    e.stopPropagation();
    arrangeWindows();
    refreshTaskbar();
    setWinMenu(false);
  });
  list.appendChild(arr);
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setWinMenu(!menuOpen);
  });
  // 点击菜单外任意处收起；Escape 收起
  document.addEventListener('pointerdown', function (e) {
    if (!menuOpen) return;
    const wrap = document.getElementById('winMenu');
    if (wrap && wrap.contains(e.target)) return;
    setWinMenu(false);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setWinMenu(false);
  });
}

function hide(st) {
  if (!st.visible) return;
  st.visible = false;
  st.el.classList.remove('focused');
  if (focusedId === st.def.id) focusedId = null;
  st.el.style.display = 'none';
  refreshTaskbar();
  saveLayout();
  bus.emit('win-hidden', st.def.id);
}

function show(st) {
  if (st.visible) { focus(st); return; }
  st.visible = true;
  st.el.style.display = 'flex';
  if (st.def.fixed) {
    // 固定栏：重开即回预设槽位（位置与大小恒定）
    st.rect = defaultRect(st.def);
    applyRect(st);
    focus(st);
    saveLayout();
    bus.emit('win-shown', st.def.id);
    return;
  }
  if (st.def.popup) {
    // 弹出层：保持在拖动后的位置（覆盖层不参与空白重排）
    focus(st);
    saveLayout();
    bus.emit('win-shown', st.def.id);
    return;
  }
  // 仍处于停靠关系 → 回到停靠位置；否则原位置被占用则另寻空白
  if (st.dock) {
    const T = winState.get(st.dock.targetId);
    if (T && T.visible) updateFollowers(T);
  } else {
    const free = findFreeRect(st.def.id, st.rect);
    if (free) { st.rect = free; applyRect(st); }
  }
  focus(st);
  saveLayout();
  bus.emit('win-shown', st.def.id);
}

function toggle(st) {
  if (st.visible) {
    if (st.focused) hide(st);
    else focus(st);
  } else {
    show(st);
  }
}

/* ---------- 锁定 ---------- */
function setLocked(st, locked) {
  if (st.def.fixed) {
    // 固定栏：永久锁定，禁止解锁
    st.locked = true;
    st.el.classList.remove('unlocked');
    const btn = st.el.querySelector('.win-lock');
    if (btn) {
      btn.textContent = '🔒';
      btn.classList.add('locked', 'fixed');
      btn.title = '固定栏：位置与大小固定，禁止更改';
    }
    return;
  }
  st.locked = !!locked;
  st.el.classList.toggle('unlocked', !st.locked);
  const btn = st.el.querySelector('.win-lock');
  if (btn) {
    btn.textContent = st.locked ? '🔒' : '🔓';
    btn.classList.toggle('locked', st.locked);
    btn.title = st.locked
      ? '已锁定：禁止移动与缩放（点击解锁）'
      : '已解锁：可拖动（悬浮停靠/磁吸）与缩放（点击锁定）';
  }
  saveLayout();
}

/* ---------- 预览浮层 ---------- */
function ensurePreviews() {
  if (!dockEl) {
    dockEl = document.createElement('div');
    dockEl.className = 'dock-preview';
    desktopEl.appendChild(dockEl);
  }
  if (!snapEl) {
    snapEl = document.createElement('div');
    snapEl.className = 'snap-preview';
    desktopEl.appendChild(snapEl);
  }
}

function clientToCanvas(cx, cy) {
  const br = desktopEl.getBoundingClientRect();
  return { x: cx - br.left + desktopEl.scrollLeft, y: cy - br.top + desktopEl.scrollTop };
}

function showDockPreview(hit, side) {
  ensurePreviews();
  const br = hit.el.getBoundingClientRect();
  const d = desktopEl.getBoundingClientRect();
  let l, t, w, h;
  switch (side) {
    case 'left':   l = br.left; t = br.top; w = br.width / 2 - GAP / 2; h = br.height; break;
    case 'right':  l = br.left + br.width / 2 + GAP / 2; t = br.top; w = br.width / 2 - GAP / 2; h = br.height; break;
    case 'top':    l = br.left; t = br.top; w = br.width; h = br.height / 2 - GAP / 2; break;
    case 'bottom': l = br.left; t = br.top + br.height / 2 + GAP / 2; w = br.width; h = br.height / 2 - GAP / 2; break;
  }
  dockEl.style.display = 'block';
  dockEl.style.left = (l - d.left + desktopEl.scrollLeft) + 'px';
  dockEl.style.top = (t - d.top + desktopEl.scrollTop) + 'px';
  dockEl.style.width = w + 'px';
  dockEl.style.height = h + 'px';
}

function hideDockPreview() { if (dockEl) dockEl.style.display = 'none'; }

function showSnapPreview(r) {
  ensurePreviews();
  snapEl.style.display = 'block';
  snapEl.style.left = r.x + 'px';
  snapEl.style.top = r.y + 'px';
  snapEl.style.width = r.w + 'px';
  snapEl.style.height = r.h + 'px';
}

function hideSnapPreview() { if (snapEl) snapEl.style.display = 'none'; }

/* ---------- 拖拽落点候选 ---------- */
function windowAtPoint(cx, cy, excludeId) {
  for (const st of winState.values()) {
    if (st.def.id === excludeId || !st.visible) continue;
    const br = st.el.getBoundingClientRect();
    if (cx >= br.left && cx <= br.right && cy >= br.top && cy <= br.bottom) return st;
  }
  return null;
}

function zoneSideFor(hit, cx, cy) {
  const br = hit.el.getBoundingClientRect();
  const dx = (cx - br.left) / br.width;
  const dy = (cy - br.top) / br.height;
  if (dx < 0.25) return 'left';
  if (dx > 0.75) return 'right';
  if (dy < 0.5) return 'top';
  return 'bottom';
}

function canDock(st, hit, side) {
  const T = hit.rect;
  if (st.def.fixed || st.def.popup || hit.def.fixed || hit.def.popup) return false; // 固定栏与弹出层不参与停靠
  if (isDockLinked(st.def.id, hit.def.id)) return false;
  if (side === 'right' || side === 'left') {
    const half = (T.w - GAP) / 2;
    return half >= st.def.minW && half >= hit.def.minW && T.h >= st.def.minH;
  }
  const half = (T.h - GAP) / 2;
  return half >= st.def.minH && half >= hit.def.minH && T.w >= st.def.minW;
}

/** 空白处磁吸候选：桌面边缘 Aero 吸附 / 对齐其他窗口边缘（均需落点合法） */
function magneticCandidate(st, r) {
  const d = { w: canvasW, h: canvasH };
  const cands = [];
  // 桌面边缘
  if (Math.abs(r.x) <= SNAP) cands.push({ x: 0, y: r.y, w: d.w / 2, h: d.h, dist: Math.abs(r.x) });
  if (Math.abs(r.x + r.w - d.w) <= SNAP) cands.push({ x: d.w / 2, y: r.y, w: d.w / 2, h: d.h, dist: Math.abs(r.x + r.w - d.w) });
  if (Math.abs(r.y) <= SNAP) cands.push({ x: r.x, y: 0, w: d.w, h: d.h, dist: Math.abs(r.y) });
  if (Math.abs(r.y + r.h - d.h) <= SNAP) cands.push({ x: r.x, y: d.h / 2, w: d.w, h: d.h / 2, dist: Math.abs(r.y + r.h - d.h) });
  // 四角
  const corners = [
    { x: 0, y: 0, w: d.w / 2, h: d.h / 2, dx: Math.abs(r.x), dy: Math.abs(r.y) },
    { x: d.w / 2, y: 0, w: d.w / 2, h: d.h / 2, dx: Math.abs(r.x + r.w - d.w), dy: Math.abs(r.y) },
    { x: 0, y: d.h / 2, w: d.w / 2, h: d.h / 2, dx: Math.abs(r.x), dy: Math.abs(r.y + r.h - d.h) },
    { x: d.w / 2, y: d.h / 2, w: d.w / 2, h: d.h / 2, dx: Math.abs(r.x + r.w - d.w), dy: Math.abs(r.y + r.h - d.h) }
  ];
  for (const c of corners) {
    if (c.dx <= SNAP && c.dy <= SNAP) cands.push({ x: c.x, y: c.y, w: c.w, h: c.h, dist: c.dx + c.dy });
  }
  // 对齐其他窗口边缘（相邻放置；弹出层除外）
  for (const other of winState.values()) {
    if (other.def.id === st.def.id || !other.visible || other.def.popup) continue;
    if (isDockLinked(st.def.id, other.def.id)) continue;
    const o = other.rect;
    if (Math.abs(r.x - (o.x + o.w + GAP)) <= SNAP) cands.push({ x: o.x + o.w + GAP, y: r.y, w: r.w, h: r.h, dist: Math.abs(r.x - (o.x + o.w + GAP)) });
    if (Math.abs((r.x + r.w) - (o.x - GAP)) <= SNAP) cands.push({ x: o.x - GAP - r.w, y: r.y, w: r.w, h: r.h, dist: Math.abs((r.x + r.w) - (o.x - GAP)) });
    if (Math.abs(r.y - (o.y + o.h + GAP)) <= SNAP) cands.push({ x: r.x, y: o.y + o.h + GAP, w: r.w, h: r.h, dist: Math.abs(r.y - (o.y + o.h + GAP)) });
    if (Math.abs((r.y + r.h) - (o.y - GAP)) <= SNAP) cands.push({ x: r.x, y: o.y - GAP - r.h, w: r.w, h: r.h, dist: Math.abs((r.y + r.h) - (o.y - GAP)) });
  }
  cands.sort(function (a, b) { return a.dist - b.dist; });
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const rr = { x: c.x, y: c.y, w: c.w, h: c.h };
    if (rr.w > 0 && rr.h > 0 && isRectValid(st.def.id, rr)) return rr;
  }
  return null;
}

/* ---------- 拖动（VS Code 式悬浮 + 停靠 + 磁吸） ---------- */
function wireDrag(st) {
  const bar = st.el.querySelector('.win-bar');
  if (!bar) return;
  bar.addEventListener('pointerdown', function (e) {
    if (st.locked || st.def.fixed) return;
    if (e.target.classList.contains('win-btn')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    focus(st);
    const sx = e.clientX, sy = e.clientY;
    const base = { x: st.rect.x, y: st.rect.y, w: st.rect.w, h: st.rect.h };
    const startRect = { x: base.x, y: base.y, w: base.w, h: base.h };
    let detached = false;
    let pending = { kind: 'free' };
    // 记录停靠在本窗口上的窗口初始位置（落点回弹时一并还原）
    const followerSnapshot = [];
    for (const f of winState.values()) {
      if (f.visible && f.dock && f.dock.targetId === st.def.id) {
        followerSnapshot.push({ id: f.def.id, r: { x: f.rect.x, y: f.rect.y, w: f.rect.w, h: f.rect.h } });
      }
    }
    // 拖拽中抬升到最上层并半透明（暂时悬浮在其他窗口上）
    st.el.classList.add('dragging');
    st.el.style.zIndex = '1300';

    function move(ev) {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!detached && (Math.abs(dx) + Math.abs(dy)) > 4) {
        detached = true;
        if (st.dock) {
          st.dock = null;
          refreshDockBadges();
        }
      }
      // 窗口跟随光标（允许悬浮在其他窗口之上），仅限制在桌面内
      st.rect = { x: base.x + dx, y: base.y + dy, w: base.w, h: base.h };
      clampRect(st);
      applyRect(st);
      updateFollowers(st, dx, dy);

      const hit = windowAtPoint(ev.clientX, ev.clientY, st.def.id);
      if (hit) {
        const side = zoneSideFor(hit, ev.clientX, ev.clientY);
        if (canDock(st, hit, side)) {
          showDockPreview(hit, side);
          hideSnapPreview();
          pending = { kind: 'dock', target: hit, side: side };
        } else {
          hideDockPreview();
          hideSnapPreview();
          pending = { kind: 'free' };
        }
      } else {
        hideDockPreview();
        const cand = magneticCandidate(st, st.rect);
        if (cand) {
          showSnapPreview(cand);
          pending = { kind: 'snap', rect: cand };
        } else {
          hideSnapPreview();
          pending = { kind: 'free' };
        }
      }
    }

    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      hideDockPreview();
      hideSnapPreview();
      st.el.classList.remove('dragging');
      st.el.style.zIndex = '';

      if (pending.kind === 'dock') {
        dockInto(st, pending.target, pending.side);
      } else if (pending.kind === 'snap') {
        st.rect = pending.rect;
        clampRect(st);
        applyRect(st);
        updateFollowers(st);
      } else {
        // 自由落点：与其他窗口重叠 → 弹回原位（含停靠本窗口的窗口）
        // 弹出层是覆盖层，允许叠放在任何窗口之上，不参与弹回校验
        if (!st.def.popup && !isRectValid(st.def.id, st.rect)) {
          st.rect = { x: startRect.x, y: startRect.y, w: startRect.w, h: startRect.h };
          applyRect(st);
          for (const f of followerSnapshot) {
            const fst = winState.get(f.id);
            if (fst) { fst.rect = f.r; applyRect(fst); }
          }
        }
      }
      refreshDockBadges();
      persistSoon();
      bus.emit('win-moved', st.def.id);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

/* ---------- 八向缩放（磁吸 + 停靠边界联动） ---------- */
function snapResize(st, dir) {
  const d = { w: canvasW, h: canvasH };
  const r = st.rect;
  if (dir.indexOf('e') >= 0 && Math.abs(r.x + r.w - d.w) <= SNAP) r.w = d.w - r.x;
  if (dir.indexOf('w') >= 0 && Math.abs(r.x) <= SNAP) { r.w += r.x; r.x = 0; }
  if (dir.indexOf('s') >= 0 && Math.abs(r.y + r.h - d.h) <= SNAP) r.h = d.h - r.y;
  if (dir.indexOf('n') >= 0 && Math.abs(r.y) <= SNAP) { r.h += r.y; r.y = 0; }
  for (const other of winState.values()) {
    if (other.def.id === st.def.id || !other.visible) continue;
    if (isDockLinked(st.def.id, other.def.id)) continue;
    const o = other.rect;
    const vOverlap = r.y < o.y + o.h && r.y + r.h > o.y;
    const hOverlap = r.x < o.x + o.w && r.x + r.w > o.x;
    if (vOverlap) {
      if (dir.indexOf('e') >= 0 && Math.abs(r.x + r.w - o.x) <= SNAP && (o.x - GAP - r.x) >= st.def.minW) r.w = o.x - GAP - r.x;
      if (dir.indexOf('w') >= 0 && Math.abs(r.x - (o.x + o.w)) <= SNAP) {
        const nw = r.w + r.x - (o.x + o.w + GAP);
        if (nw >= st.def.minW) { r.x = o.x + o.w + GAP; r.w = nw; }
      }
    }
    if (hOverlap) {
      if (dir.indexOf('s') >= 0 && Math.abs(r.y + r.h - o.y) <= SNAP && (o.y - GAP - r.y) >= st.def.minH) r.h = o.y - GAP - r.y;
      if (dir.indexOf('n') >= 0 && Math.abs(r.y - (o.y + o.h)) <= SNAP) {
        const nh = r.h + r.y - (o.y + o.h + GAP);
        if (nh >= st.def.minH) { r.y = o.y + o.h + GAP; r.h = nh; }
      }
    }
  }
}

function wireResize(st) {
  if (st.def.fixed || st.def.popup) return; // 固定栏与弹出层：不生成缩放热区，尺寸不可更改
  for (const dir of RESIZE_DIRS) {
    const h = document.createElement('div');
    h.className = 'rs rs-' + dir;
    h.dataset.dir = dir;
    st.el.appendChild(h);
    h.addEventListener('pointerdown', function (e) {
      if (st.locked) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      focus(st);
      const sx = e.clientX, sy = e.clientY;
      const or = { x: st.rect.x, y: st.rect.y, w: st.rect.w, h: st.rect.h };
      let last = { x: or.x, y: or.y, w: or.w, h: or.h };
      function move(ev) {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let { x, y, w, h: hh } = or;
        if (dir.indexOf('e') >= 0) w = or.w + dx;
        if (dir.indexOf('s') >= 0) hh = or.h + dy;
        if (dir.indexOf('w') >= 0) { w = or.w - dx; x = or.x + dx; }
        if (dir.indexOf('n') >= 0) { hh = or.h - dy; y = or.y + dy; }
        if (w < st.def.minW) { if (dir.indexOf('w') >= 0) x -= (st.def.minW - w); w = st.def.minW; }
        if (hh < st.def.minH) { if (dir.indexOf('n') >= 0) y -= (st.def.minH - hh); hh = st.def.minH; }
        const cand = { x: x, y: y, w: Math.min(w, canvasW - 4), h: Math.min(hh, canvasH - 4) };
        st.rect = cand;
        syncBoundary(st);        // 停靠边界双向联动
        snapResize(st, dir);     // 磁吸对齐
        if (isRectValid(st.def.id, st.rect)) { last = { x: st.rect.x, y: st.rect.y, w: st.rect.w, h: st.rect.h }; }
        else st.rect = last;     // 撞到其他窗口/边界：停在最后合法尺寸
        applyRect(st);
        bus.emit('win-resizing', st.def.id);
      }
      function up() {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        updateFollowers(st);     // 停靠本窗口的窗口跟随新尺寸
        refreshDockBadges();
        persistSoon();
        bus.emit('win-resized', st.def.id);
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  }
}

function wireWindow(st) {
  st.el.addEventListener('pointerdown', function () { focus(st); }, true);
  wireDrag(st);
  wireResize(st);
  const lockBtn = st.el.querySelector('.win-lock');
  const minBtn = st.el.querySelector('.win-min');
  const closeBtn = st.el.querySelector('.win-close');
  if (lockBtn) {
    if (st.def.fixed) {
      // 固定栏：永久锁定，不响应点击（位置与大小不可更改）
      lockBtn.classList.add('fixed');
      lockBtn.title = '固定栏：位置与大小固定，禁止更改';
    } else {
      lockBtn.addEventListener('click', function (e) { e.stopPropagation(); setLocked(st, !st.locked); });
    }
  }
  if (minBtn) minBtn.addEventListener('click', function (e) { e.stopPropagation(); hide(st); });
  if (closeBtn) closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hide(st); });
}

/** 「▦ 整理」：解除全部停靠、重新显示全部窗口并恢复默认分屏（弹出层复位并收起） */
function arrangeWindows() {
  for (const st of winState.values()) {
    if (st.def.popup) {
      st.rect = defaultRect(st.def);
      applyRect(st);
      hide(st);
      continue;
    }
    st.visible = true;
    st.el.style.display = 'flex';
    st.dock = null;
    st.rect = defaultRect(st.def);
    applyRect(st);
  }
  refreshDockBadges();
  saveLayout();
  const first = winState.get('scope') || winState.values().next().value;
  if (first) focus(first);
}

/* ---------- 初始化 ---------- */
export function initWM() {
  desktopEl = document.getElementById('desktop');
  innerEl = document.getElementById('desktopInner');
  if (!desktopEl || !innerEl) return;
  const saved = loadSaved();
  computeCanvas();

  for (const def of WIN_DEFS) {
    const el = document.querySelector('.win[data-win="' + def.id + '"]');
    if (!el) continue;
    const s = saved[def.id] || {};
    const st = {
      def: def,
      el: el,
      rect: { x: 0, y: 0, w: def.minW, h: def.minH },
      visible: def.popup ? (s.visible === true) : (s.visible !== false), // 弹出层默认隐藏
      locked: def.fixed ? true : (def.popup ? false : (s.locked !== false)), // 弹出层恒解锁（无锁按钮，可自由拖动）
      dock: (!def.fixed && !def.popup && s.dock && s.dock.targetId) ? { targetId: s.dock.targetId, side: s.dock.side || 'right' } : null,
      focused: false
    };
    el.classList.toggle('fixed-win', !!def.fixed);
    el.classList.toggle('win-popup', !!def.popup);
    let r = null;
    if (def.fixed) {
      // 固定栏：始终回到预设槽位，忽略旧布局记忆
      r = defaultRect(def);
    } else if (typeof s.x === 'number' && typeof s.w === 'number') {
      r = { x: s.x, y: s.y, w: Math.max(def.minW, s.w), h: Math.max(def.minH, s.h) };
      if (def.popup) {
        // 弹出层：恢复记忆位置（仅限制在桌面内，允许覆盖其他窗口）
        r.x = Math.max(-r.w + 70, Math.min(canvasW - 70, r.x));
        r.y = Math.max(0, Math.min(canvasH - 26, r.y));
      } else if (!isRectValid(def.id, r)) {
        r = findFreeRect(def.id, r);
      }
    }
    if (!r) r = defaultRect(def);
    if (!isRectValid(def.id, r)) r = findFreeRect(def.id, r) || r;
    st.rect = r;
    winState.set(def.id, st);
    wireWindow(st);
    applyRect(st);
    if (!st.visible) st.el.style.display = 'none';
    setLocked(st, st.locked);
  }

  // 恢复停靠关系：按目标重排一次
  for (const st of winState.values()) {
    if (st.dock && st.visible) {
      const T = winState.get(st.dock.targetId);
      if (T && T.visible) updateFollowers(T);
    }
  }
  refreshDockBadges();

  wireTaskbar();
  refreshTaskbar();

  // 弹出层：点击窗口外任意处（任务栏除外）自动收起
  desktopEl.addEventListener('pointerdown', function (e) {
    const t = e.target;
    if (t && t.closest && t.closest('.taskbar')) return;
    for (const st of winState.values()) {
      if (!st.def.popup || !st.visible) continue;
      if (st.el.contains(t)) continue;
      hide(st);
    }
  }, true);

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { computeCanvas(); }).observe(desktopEl);
  } else {
    window.addEventListener('resize', function () { computeCanvas(); });
  }

  const first = winState.get('scope') || winState.values().next().value;
  if (first) focus(first);

  bus.on('open-window', function (id) { showWindow(id); });
}

export function showWindow(id) {
  const st = winState.get(id);
  if (st) show(st);
}

export function isWindowVisible(id) {
  const st = winState.get(id);
  return !!(st && st.visible);
}

/** 调试探针：导出内部窗口状态（供 --dev-probe 诊断） */
export function _debugState() {
  const out = {};
  for (const st of winState.values()) {
    out[st.def.id] = {
      x: Math.round(st.rect.x), y: Math.round(st.rect.y),
      w: Math.round(st.rect.w), h: Math.round(st.rect.h),
      visible: st.visible, locked: st.locked,
      dock: st.dock ? st.dock : null
    };
  }
  return { canvas: { w: Math.round(canvasW), h: Math.round(canvasH) }, wins: out };
}
