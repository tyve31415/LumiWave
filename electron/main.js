/* =========================================================
   LumiWave · Electron 主进程
   职责：窗口管理、原生菜单、文件对话框、最近文件、
        窗口状态持久化、防 CPU 节流、IPC 路由
   ========================================================= */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const IS_DEV = process.argv.includes('--dev');
// 无窗口自检模式：跑完探针自动退出（不打扰用户桌面）
const IS_PROBE = process.argv.includes('--dev-probe');
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent-files.json');
const FAVORITES_FILE = () => path.join(app.getPath('userData'), 'favorites.json');
const MAX_RECENT = 8;
const MAX_FAVORITES = 20;
const AUDIO_RE = /\.(wav|mp3|flac|ogg|m4a|aac|webm)$/i;
const MAX_LIST_ENTRIES = 2000;
const MAX_AUDIO_READ = 512 * 1024 * 1024;

/** @type {BrowserWindow | null} */
let mainWindow = null;
let recentFiles = [];
let powerBlockerId = null;
let recording = false;

/* ---------- 最近文件持久化 ---------- */
function loadRecentFiles() {
  try {
    const raw = fs.readFileSync(RECENT_FILE(), 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      recentFiles = list.filter(function (p) { return typeof p === 'string' && p.length < 512; }).slice(0, MAX_RECENT);
    }
  } catch (err) { recentFiles = []; }
}

function saveRecentFiles() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(recentFiles, null, 2), 'utf8');
  } catch (err) { /* 忽略写入失败 */ }
}

function pushRecent(filePath) {
  try {
    const abs = path.resolve(filePath);
    recentFiles = recentFiles.filter(function (p) { return p.toLowerCase() !== abs.toLowerCase(); });
    recentFiles.unshift(abs);
    recentFiles = recentFiles.slice(0, MAX_RECENT);
    saveRecentFiles();
    rebuildMenu();
  } catch (err) { /* 忽略 */ }
}

function recentLabel(p) {
  const base = path.basename(p);
  return base.length > 40 ? base.slice(0, 37) + '…' : base;
}

function isMidi(p) { return /\.midi?$/i.test(p); }
function isAudio(p) { return AUDIO_RE.test(p); }

/* ---------- 收藏夹（音乐文件夹）持久化 ---------- */
function loadFavorites() {
  try {
    const raw = fs.readFileSync(FAVORITES_FILE(), 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.filter(function (p) { return typeof p === 'string' && p.length < 512; }).slice(0, MAX_FAVORITES);
    }
  } catch (err) { /* 首次启动 */ }
  return [];
}

function saveFavorites(list) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const clean = Array.isArray(list)
      ? list.filter(function (p) { return typeof p === 'string' && p.length < 512; }).slice(0, MAX_FAVORITES)
      : [];
    fs.writeFileSync(FAVORITES_FILE(), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  } catch (err) { return null; }
}

/* ---------- 文件夹浏览（资源管理器式收藏夹） ---------- */
function listDirEntries(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { error: '不是文件夹' };
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of ents) {
      if (dirs.length + files.length >= MAX_LIST_ENTRIES) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full });
        } else if (e.isFile() && AUDIO_RE.test(e.name)) {
          const fst = fs.statSync(full);
          files.push({ name: e.name, path: full, size: fst.size, mtimeMs: fst.mtimeMs });
        }
      } catch (err) { /* 单个条目失败则跳过 */ }
    }
    dirs.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    files.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    return { dirs: dirs, files: files };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function validDirPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 1024 && path.isAbsolute(p);
}

function readAudioByPath(p) {
  try {
    if (!AUDIO_RE.test(p)) return { error: '不支持的音频格式' };
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: '不是文件' };
    if (st.size > MAX_AUDIO_READ) return { error: '文件过大（超过 512 MB）' };
    return { name: path.basename(p), data: fs.readFileSync(p) };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/* ---------- 窗口状态持久化 ---------- */
function loadWindowState() {
  const def = { width: 1280, height: 860 };
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
    if (s && typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch (err) { /* 首次启动 */ }
  return def;
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || IS_PROBE) return; // 探针模式不写窗口状态（避免干扰用户实例）
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const state = { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() };
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(state), 'utf8');
  } catch (err) { /* 忽略写入失败 */ }
}

/* ---------- 菜单 ---------- */
function sendMenu(cmd, arg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-command', cmd, arg);
}

async function pickFile(kind) {
  if (!mainWindow) return null;
  const filters = kind === 'midi'
    ? [{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }]
    : [{ name: '音频文件', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'webm'] }];
  const r = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'midi' ? '导入 MIDI 文件' : '导入音频文件',
    properties: ['openFile'],
    filters: filters
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  let buf = null;
  try { buf = fs.readFileSync(p); } catch (err) { return null; }
  pushRecent(p);
  return { path: p, name: path.basename(p), data: buf };
}

async function importViaDialog(kind) {
  const payload = await pickFile(kind);
  if (payload) sendMenu(kind === 'midi' ? 'open-midi' : 'open-audio', payload);
}

async function openRecentByPath(p) {
  if (!mainWindow) return;
  let buf = null;
  try { buf = fs.readFileSync(p); } catch (err) { return; }
  pushRecent(p);
  if (isMidi(p)) sendMenu('open-midi', { path: p, name: path.basename(p), data: buf });
  else sendMenu('open-audio', { path: p, name: path.basename(p), data: buf });
}

function buildMenuTemplate() {
  const recentItems = recentFiles.map(function (p, i) {
    return { label: recentLabel(p), click: function () { openRecentByPath(p); } };
  });
  if (recentItems.length) recentItems.push({ type: 'separator' });
  recentItems.push({ label: '清空最近文件', enabled: recentFiles.length > 0, click: function () { recentFiles = []; saveRecentFiles(); rebuildMenu(); } });

  return [
    {
      label: '文件',
      submenu: [
        { label: '导入 MIDI…', accelerator: 'CmdOrCtrl+O', click: function () { importViaDialog('midi'); } },
        { label: '导入音频…', accelerator: 'CmdOrCtrl+Shift+O', click: function () { importViaDialog('audio'); } },
        { type: 'separator' },
        { label: '最近文件', submenu: recentItems },
        { type: 'separator' },
        { label: '导出 WAV…', accelerator: 'CmdOrCtrl+E', click: function () { sendMenu('export-wav'); } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: function () { app.quit(); } }
      ]
    },
    {
      label: '播放',
      submenu: [
        { label: '播放 / 停止合成器', accelerator: 'CmdOrCtrl+Enter', click: function () { sendMenu('toggle-engine'); } },
        { label: '播放 / 停止演示曲', accelerator: 'CmdOrCtrl+D', click: function () { sendMenu('toggle-demo'); } },
        { label: '时间线 ▶', click: function () { sendMenu('timeline-play'); } },
        { label: '时间线 ■', click: function () { sendMenu('timeline-stop'); } },
        { type: 'separator' },
        { label: '音序器 ▶', click: function () { sendMenu('sequencer-toggle'); } },
        { type: 'separator' },
        { label: '开始 / 停止录制', accelerator: 'CmdOrCtrl+R', click: function () { sendMenu('toggle-record'); } },
        { type: 'separator' },
        { label: '全部停止（释放所有音符）', click: function () { sendMenu('stop-all'); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '波形 / 频谱切换', accelerator: 'CmdOrCtrl+T', click: function () { sendMenu('toggle-scope'); } },
        { type: 'separator' },
        { label: '窗口置顶', type: 'checkbox', checked: false, click: function (item) {
          if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
        } },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开使用教程（Markdown）', click: function () {
          // 打包后教程作为 extraResources 放在 resources 目录
          const p = app.isPackaged
            ? path.join(process.resourcesPath, '使用教程.md')
            : path.join(__dirname, '..', '使用教程.md');
          shell.openPath(p);
        } },
        ...(app.isPackaged ? [] : [{ label: '在资源管理器中显示项目文件夹', click: function () {
          shell.openPath(path.join(__dirname, '..'));
        } }]),
        { type: 'separator' },
        { label: '关于', click: function () { showAbout(); } }
      ]
    }
  ];
}

function rebuildMenu() {
  if (!mainWindow) return;
  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  Menu.setApplicationMenu(menu);
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 LumiWave',
    message: 'LumiWave · 示波器合成器',
    detail: '16 声部芯片音乐合成器：公式波形合成 + CH1–CH4 大通道路由 + MIDI 导入 + 时间线编辑器\n\nElectron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + ' · Node ' + process.versions.node,
    buttons: ['好的']
  });
}

/* ---------- 电源管理：播放期间防 CPU 节流 ---------- */
function setActive(on) {
  if (on && powerBlockerId === null) {
    try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (err) { powerBlockerId = null; }
  } else if (!on && powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch (err) { /* 忽略 */ }
    powerBlockerId = null;
  }
}

/* ---------- 窗口 ---------- */
function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#010402',
    title: 'LumiWave · 示波器合成器',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  if (state.maximized) mainWindow.maximize();

  if (!IS_PROBE) mainWindow.once('ready-to-show', function () { mainWindow.show(); });

  // 开发/探针模式：尽早转发渲染进程控制台（含初始化阶段的未捕获异常）
  if (IS_DEV || IS_PROBE) {
    mainWindow.webContents.on('console-message', function (event, level, message) {
      console.log('[renderer:' + level + '] ' + message);
    });
  }

  // 开发模式：加载完成后探测渲染进程健康状态（输出到终端）
  mainWindow.webContents.on('did-finish-load', function () {
    if (!IS_DEV && !IS_PROBE) return;
    const probe = function (name, code) {
      console.log('[probe] starting ' + name + ' ...');
      const work = mainWindow.webContents.executeJavaScript(code);
      const guard = new Promise(function (resolve) {
        setTimeout(function () { resolve({ __timeout: true, name: name }); }, 15000);
      });
      return Promise.race([work, guard]).then(function (r) {
        if (r && r.__timeout) {
          console.error('[probe] ' + name + ' TIMED OUT after 15s');
        } else {
          console.log('[probe] ' + name + ':', JSON.stringify(r));
        }
        return r;
      }).catch(function (err) {
        console.error('[probe] ' + name + ' failed:', err && err.message);
        return null;
      });
    };

    const finish = function () {
      if (IS_PROBE) setTimeout(function () { app.quit(); }, 400);
    };

    // 0. 入口模块装载（若页面脚本失败，这里给出具体错误）
    probe('main-module',
      'import("./main.js").then(function(){ return { ok: true, sin: typeof window.sin, voices: document.querySelectorAll(".voice").length, strips: document.querySelectorAll(".channel-row").length }; }).catch(function(err){ return { ok: false, err: String((err && err.message) || err), stack: String((err && err.stack) || "") }; })'
    ).then(function () {
      // 1. UI 结构
      return probe('renderer',
        '({ voices: document.querySelectorAll(".voice").length, keys: document.querySelectorAll(".key").length, steps: document.querySelectorAll(".step").length, lanes: document.querySelectorAll(".tl-lane").length, title: document.title, windows: document.querySelectorAll(".win").length, strips: document.querySelectorAll(".channel-row").length, chips: document.querySelectorAll(".ch-chip").length, favList: !!document.getElementById("favList"), tree: !!document.getElementById("explorerTree") })'
      );
    }).then(function () {
      // 1.5. 布局结构：窗口几何 / 示波器画布尺寸 / 缩放热区
      return probe('layout',
        '({ desktop: (function(){ var d = document.getElementById("desktop").getBoundingClientRect(); return { w: Math.round(d.width), h: Math.round(d.height) }; })(), wins: (function(){ var out = []; document.querySelectorAll(".win").forEach(function(w){ if (w.style.display === "none") return; var r = w.getBoundingClientRect(); out.push({ id: w.dataset.win, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); }); return out; })(), scope: (function(){ var c = document.getElementById("scope"); return { w: c.clientWidth, h: c.clientHeight }; })(), rsHandles: document.querySelectorAll(".rs").length, menuItems: document.querySelectorAll(".win-menu-item").length })'
      );
    }).then(function () {
      // 1.8. VS Code 式窗口逻辑：锁定 / 悬浮拖动 / 分屏停靠 / 磁吸 / 无重叠 + 左列固定栏 + 顶栏弹出层
      // 断言基于 wm 内部状态（隐藏探针窗口的 DOM 布局重算会延迟，不可靠）
      return probe('constraints',
        '(async function(){' +
        '  var settle = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };' +
        '  function pe(t, type, x, y){ t.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })); }' +
        '  function ovInternal(d){ var ws=d.wins, ids=Object.keys(ws), o=[]; for(var i=0;i<ids.length;i++)for(var j=i+1;j<ids.length;j++){ var a=ws[ids[i]], b=ws[ids[j]]; if(!a.visible||!b.visible)continue; if(a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y)o.push(ids[i]+"x"+ids[j]); } return o; }' +
        // 0) 先归一化布局：忽略用户记忆的窗口状态，从默认分屏开始测试
        //    归一化前先检查弹出层载入尺寸（旧版保存的小尺寸不得生效）
        '  var m = await import("./ui/wm.js");' +
        '  var dPre = m._debugState();' +
        '  var popupSizeOk = Math.abs(dPre.wins.channels.h - dPre.canvas.h * 320 / 800) <= 4;' +
        '  document.querySelector(".win-menu-arrange").click();' +
        '  await settle(120);' +
        '  var d0 = m._debugState();' +
        '  var ex0 = d0.wins.explorer;' +
        '  var w = document.querySelector(".win[data-win=timeline]");' +
        '  var bar = w.querySelector(".win-bar");' +
        '  var locks = document.querySelectorAll(".win-lock").length;' +
        '  if (!w.classList.contains("unlocked")) w.querySelector(".win-lock").click();' +
        '  var unlocked = w.classList.contains("unlocked");' +
        '  var handleVisible = (function(){ var h = w.querySelector(".rs"); return h ? getComputedStyle(h).display !== "none" : false; })();' +
        // 固定栏（收藏夹·本地音乐合体窗口）：无锁按钮、不可解锁、无缩放热区、贴左缘、几何恒定
        '  var ex = document.querySelector(".win[data-win=explorer]");' +
        '  var noLockBtn = !ex.querySelector(".win-lock");' +
        '  var fixedStillLocked = d0.wins.explorer.locked === true && !ex.classList.contains("unlocked");' +
        '  var fixedNoHandles = !ex.querySelector(".rs");' +
        '  var leftCol = ex0.x <= 20 && ex0.y <= 20 && (d0.canvas.h - ex0.y - ex0.h) <= 20;' +
        // 0) 顶栏「🪟 窗口」菜单：导航栏不得裁剪弹出列表，点击开合正常
        '  var navOverflow = getComputedStyle(document.querySelector(".taskbar-wins")).overflowX;' +
        '  var menuBtn = document.getElementById("winMenuBtn");' +
        '  var menuList = document.getElementById("winMenuList");' +
        '  menuBtn.click();' +
        '  var menuOpenOk = menuList.hidden === false;' +
        '  var menuItemCount = menuList.querySelectorAll(".win-menu-item").length;' +
        '  menuBtn.click();' +
        '  var menuClosedOk = menuList.hidden === true;' +
        '  await settle(100);' +
        '  var r0 = w.getBoundingClientRect();' +
        '  var sc = document.querySelector(".win[data-win=scope]").getBoundingClientRect();' +
        // 1) 拖到示波器右缘条带 → 分屏停靠（示波器让出右半区）
        '  pe(bar, "pointerdown", r0.left + 10, r0.top + 10);' +
        '  pe(document, "pointermove", sc.left + sc.width * 0.88, sc.top + sc.height * 0.5);' +
        '  pe(document, "pointerup", sc.left + sc.width * 0.88, sc.top + sc.height * 0.5);' +
        '  await settle(150);' +
        '  var d1 = m._debugState();' +
        '  var badgeEl = w.querySelector(".dock-badge");' +
        '  var docked = !!(d1.wins.timeline.dock && d1.wins.timeline.dock.targetId === "scope" && d1.wins.timeline.dock.side === "right");' +
        '  var scopeShrunk = d1.wins.scope.w < 824 - 100;' +
        '  var dockedX = d1.wins.timeline.x, dockedY = d1.wins.timeline.y;' +
        '  var ovAfterDock = ovInternal(d1);' +
        // 2) 隐藏其余窗口，拖动时间线（解除停靠）到空白处（delta 基于内部状态计算）
        '  ["mixer","channels","scope"].forEach(function(id){ document.querySelector(".win[data-win=" + id + "]").querySelector(".win-close").click(); });' +
        '  await settle(120);' +
        '  var sx2 = 600, sy2 = 500;' +
        '  var tx2 = sx2 + (360 - d1.wins.timeline.x), ty2 = sy2 + (100 - d1.wins.timeline.y);' +
        '  pe(bar, "pointerdown", sx2, sy2);' +
        '  pe(document, "pointermove", tx2, ty2);' +
        '  pe(document, "pointerup", tx2, ty2);' +
        '  await settle(150);' +
        '  var d2 = m._debugState();' +
        '  var moved = (Math.abs(d2.wins.timeline.x - dockedX) > 20 || Math.abs(d2.wins.timeline.y - dockedY) > 20);' +
        '  var detached = !d2.wins.timeline.dock;' +
        '  var ovAfterMove = ovInternal(d2);' +
        '  var fixedStable = (d2.wins.explorer.x === ex0.x && d2.wins.explorer.y === ex0.y && d2.wins.explorer.w === ex0.w && d2.wins.explorer.h === ex0.h);' +
        // 3) 弹出层（通道控制）：窗口菜单弹出、置顶覆盖、默认解锁可自由拖动、点击外部收起、再点收起
        '  var chBtn = document.querySelector(".win-menu-item[data-task=channels]");' +
        '  chBtn.click();' +
        '  await settle(80);' +
        '  var dP = m._debugState();' +
        '  var popupShown = dP.wins.channels.visible === true;' +
        '  var popupCentered = Math.abs((dP.canvas.w - dP.wins.channels.w) / 2 - dP.wins.channels.x) <= 2 && dP.wins.channels.y <= 60;' +
        '  var popupOnTop = (function(){ var cw = document.querySelector(".win[data-win=channels]"); return getComputedStyle(cw).zIndex === "1200"; })();' +
        '  var popupNoHandles = !document.querySelector(".win[data-win=channels] .rs");' +
        '  var popupNoLock = !document.querySelector(".win[data-win=channels] .win-lock");' +
        '  document.getElementById("desktop").dispatchEvent(new PointerEvent("pointerdown", { clientX: 700, clientY: 700, bubbles: true }));' +
        '  await settle(80);' +
        '  var dP2 = m._debugState();' +
        '  var popupClosedOutside = dP2.wins.channels.visible === false;' +
        '  chBtn.click();' +
        '  await settle(80);' +
        '  var dP3 = m._debugState();' +
        '  var popupReopen = dP3.wins.channels.visible === true;' +
        // 3.1) 自由拖动：弹出层恒解锁，直接拖动标题栏 → 位置改变（允许覆盖在其他窗口上）
        '  var cwEl = document.querySelector(".win[data-win=channels]");' +
        '  var cwBar = cwEl.querySelector(".win-bar");' +
        '  var popupUnlocked = cwEl.classList.contains("unlocked");' +
        '  pe(cwBar, "pointerdown", 620, 70);' +
        '  pe(document, "pointermove", 820, 370);' +
        '  pe(document, "pointerup", 820, 370);' +
        '  await settle(120);' +
        '  var dP5 = m._debugState();' +
        '  var popupMoved = (Math.abs(dP5.wins.channels.x - dP3.wins.channels.x) > 80 && Math.abs(dP5.wins.channels.y - dP3.wins.channels.y) > 80);' +
        '  chBtn.click();' +
        '  await settle(80);' +
        '  var dP4 = m._debugState();' +
        '  var popupToggleHide = dP4.wins.channels.visible === false;' +
        '  document.querySelector(".win-menu-arrange").click();' +
        '  await settle(150);' +
        '  var d3 = m._debugState();' +
        '  var visCount = 0; for (var k in d3.wins) if (d3.wins[k].visible) visCount++;' +
        '  return { locks: locks, unlocked: unlocked, handleVisible: handleVisible, noLockBtn: noLockBtn, fixedStillLocked: fixedStillLocked, fixedNoHandles: fixedNoHandles, leftCol: leftCol, fixedStable: fixedStable, navOverflow: navOverflow, menuOpenOk: menuOpenOk, menuClosedOk: menuClosedOk, menuItemCount: menuItemCount, popupSizeOk: popupSizeOk, docked: docked, badge: badgeEl ? badgeEl.textContent : null, scopeShrunk: scopeShrunk, overlapsAfterDock: ovAfterDock, moved: moved, detached: detached, overlapsAfterMove: ovAfterMove, popupShown: popupShown, popupCentered: popupCentered, popupOnTop: popupOnTop, popupNoHandles: popupNoHandles, popupNoLock: popupNoLock, popupUnlocked: popupUnlocked, popupClosedOutside: popupClosedOutside, popupReopen: popupReopen, popupMoved: popupMoved, popupToggleHide: popupToggleHide, overlapsAfterArrange: ovInternal(d3), visibleCount: visCount };' +
        '})()'
      );
    }).then(function () {
      // 2. 音频上下文 + worklet + 主线程声部编译
      return probe('audio',
        'import("./core/engine.js").then(function (e) { return e.ensureCtx().then(function () { return import("./core/channels.js").then(function (c) { return { audioCtx: !!e.ctx, worklet: !!e.mainEngine.workletNode, fallback: !!e.mainEngine.fallbackState, sr: window.SR, voiceErrors: e.mainEngine.voices.filter(function (v) { return !!v.error; }).length, voicesOn: e.mainEngine.voices.filter(function (v) { return v.enabled; }).length, channelDefs: c.CH_DEFS.length, routingReady: c.isRoutingReady(), anySolo: c.anySolo() }; }); }); })'
      );
    }).then(function () {
      // 2.5. 多引擎：时间线 / 音序器独立 worklet（验证多处理器注册与 S/P 前缀隔离）
      return probe('engines',
        'import("./core/engine.js").then(function (e) { return Promise.all([e.timelineEngine.ensureEngine(), e.seqEngine.ensureEngine()]).then(function () { return { tlWorklet: !!e.timelineEngine.workletNode, seqWorklet: !!e.seqEngine.workletNode, tlFallback: !!e.timelineEngine.fallbackState, seqFallback: !!e.seqEngine.fallbackState, tlVoices: e.timelineEngine.voices.length, seqV1Enabled: e.seqEngine.voices[0].enabled, seqGate: e.seqEngine.gateMode, tlRunning: e.timelineEngine.running, seqRunning: e.seqEngine.running }; }); })'
      );
    }).then(function () {
      // 2.6. S/P 歌曲函数运行时回归：公式含 S(ch,t) 时改写为 ch1_S 后
      // 必须在 worklet 内可运行（此前报 "ch1_S is not defined" 并停用声部）
      return probe('song-voices',
        '(async function(){' +
        '  var e = await import("./core/engine.js");' +
        '  var settle = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };' +
        '  var v = e.mainEngine.voices[0];' +
        '  var oldSrc = v.source, oldOn = v.enabled;' +
        '  v.source = "S(1, t) * 0.05";' +
        '  v.enabled = true;' +
        '  e.mainEngine.syncVoices();' +
        '  await settle(1200);' +
        '  var runtimeErr = v.error;' +
        '  var stillOn = v.enabled;' +
        '  v.source = oldSrc; v.enabled = oldOn;' +
        '  e.mainEngine.syncVoices();' +
        '  return { runtimeError: runtimeErr, stillEnabled: stillOn };' +
        '})()'
      );
    }).then(function () {
      // 2.7. 通道音源路由：默认无映射（全部未勾选）+ 勾选/取消音源（通道 = 所选音源之和）
      return probe('channel-sources',
        'import("./core/channels.js").then(function (c) {' +
        '  var defaults = c.chState.ch1.sources.mixer === false && c.chState.ch2.sources.timeline === false && c.chState.ch3.sources.music === false && c.chState.ch4.sources.seq === false && c.chState.ch1.sources.timeline === false;' +
        '  c.setChannelSource("ch1", "timeline", true);' +
        '  var toggleOn = c.chState.ch1.sources.timeline === true;' +
        '  var summary = c.channelSourceSummary("ch1");' +
        '  c.setChannelSource("ch1", "timeline", false);' +
        '  var toggleOff = c.chState.ch1.sources.timeline === false;' +
        '  return { defaults: defaults, toggleOn: toggleOn, toggleOff: toggleOff, summary: summary, routingReady: c.isRoutingReady(), anySolo: c.anySolo() };' +
        '})'
      );
    }).then(function () {
      // 2.8. 示波器视图切换：默认 4 个独立通道，顶部按钮切换为单个 MIX 通道
      return probe('scope-mix',
        'import("./ui/scope.js").then(function (s) {' +
        '  var btn = document.getElementById("mixToggle");' +
        '  var initial = btn && s.scopeState.view === "channels" && btn.textContent === "MIX";' +
        '  btn.click();' +
        '  var on = s.scopeState.view === "mix" && btn.classList.contains("on") && btn.textContent === "4CH";' +
        '  btn.click();' +
        '  var off = s.scopeState.view === "channels" && !btn.classList.contains("on");' +
        '  return { btn: !!btn, initial: initial, toggleOn: on, toggleOff: off };' +
        '})'
      );
    }).then(function () {
      // 2.9. 通道选择：单击选中高亮，再次单击取消选中；旋钮作用于选中通道（各通道参数独立）
      return probe('scope-select',
        '(async function(){' +
        '  var s = await import("./ui/scope.js");' +
        '  var cv = document.getElementById("scope");' +
        '  var rect = cv.getBoundingClientRect();' +
        '  var cx = rect.left + 40, cy = rect.top + rect.height * 0.625;' +
        '  cv.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true }));' +
        '  var selCh3 = s.scopeState.selected === "ch3";' +
        '  cv.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true }));' +
        '  var deselected = s.scopeState.selected === null;' +
        '  cv.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true }));' +
        '  var reselected = s.scopeState.selected === "ch3";' +
        '  var hasParams = !!s.scopeState.params.ch1 && !!s.scopeState.params.ch4 && !!s.scopeState.params.mix;' +
        '  var ampBefore = s.scopeState.params.ch3.amp;' +
        '  var ch1Before = s.scopeState.params.ch1.amp;' +
        '  var kv = document.getElementById("knobVert");' +
        '  kv.dispatchEvent(new PointerEvent("pointerdown", { clientY: 300, bubbles: true }));' +
        '  kv.dispatchEvent(new PointerEvent("pointermove", { clientY: 330, bubbles: true }));' +
        '  kv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));' +
        '  var ch3Changed = Math.abs(s.scopeState.params.ch3.amp - ampBefore) > 0.0001;' +
        '  var ch1Untouched = Math.abs(s.scopeState.params.ch1.amp - ch1Before) < 1e-9;' +
        '  var mb = document.getElementById("mixToggle");' +
        '  mb.click();' +
        '  var mixSelected = s.scopeState.selected === "mix";' +
        '  mb.click();' +
        '  var backToCh3 = s.scopeState.selected === "ch3";' +
        '  return { selCh3: selCh3, deselected: deselected, reselected: reselected, hasParams: hasParams, ch3Changed: ch3Changed, ch1Untouched: ch1Untouched, mixSelected: mixSelected, backToCh3: backToCh3 };' +
        '})()'
      );
    }).then(function () {
      // 3. 「应用全部函数」：完整用户流程验证（带进度日志，任何挂起点都会暴露）
      return probe('apply-button',
        '(async function () {' +
        '  var log = [];' +
        '  function step(n) { log.push(n); console.error("[page-probe] " + n); }' +
        '  try {' +
        '    step("import start");' +
        '    var e = await import("./core/engine.js");' +
        '    step("imported");' +
        '    await e.ensureCtx();' +
        '    step("ctx ready");' +
        '    function readWorklet() {' +
        '      return new Promise(function (resolve) {' +
        '        var t = setTimeout(function () { log.push("readWorklet TIMEOUT"); resolve(null); }, 2500);' +
        '        e.mainEngine.workletNode.port.addEventListener("message", function onMsg(ev) {' +
        '          if (ev.data && ev.data.type === "voicesInfo") { clearTimeout(t); e.mainEngine.workletNode.port.removeEventListener("message", onMsg); resolve(ev.data.data); }' +
        '        });' +
        '        e.mainEngine.send({ type: "getVoices" });' +
        '      });' +
        '    }' +
        '    var settle = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };' +
        '    var inputs = document.querySelectorAll(".voice-src");' +
        '    var enables = document.querySelectorAll(".voice-enable");' +
        '    var errs = document.querySelectorAll(".voice-err");' +

        '    step("edit V1");' +
        '    inputs[0].value = "sq(TWO_PI * freq * t) * 0.25 * env";' +
        '    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));' +
        '    step("click apply #1");' +
        '    document.getElementById("applyBtn").click();' +
        '    await settle(600);' +
        '    step("read worklet #1");' +
        '    var wl1 = await readWorklet();' +
        '    step("read #1 done: " + (wl1 ? wl1.length : "null"));' +

        '    step("enable V3 + bad source");' +
        '    if (!e.mainEngine.voices[2].enabled) { enables[2].click(); }' +
        '    inputs[2].value = "sin(TWO_PI * freq * t) * 0.5 * env +";' +
        '    inputs[2].dispatchEvent(new Event("input", { bubbles: true }));' +
        '    step("click apply #2");' +
        '    document.getElementById("applyBtn").click();' +
        '    await settle(600);' +
        '    step("read worklet #2");' +
        '    var wl2 = await readWorklet();' +
        '    step("read #2 done: " + (wl2 ? wl2.length : "null"));' +

        '    return {' +
        '      workletV1Src: wl1 && wl1[0] ? wl1[0].src : null,' +
        '      mainV1Err: e.mainEngine.voices[0].error || "",' +
        '      shownErr1: errs[0].textContent,' +
        '      v3Enabled: e.mainEngine.voices[2].enabled,' +
        '      mainV3Err: e.mainEngine.voices[2].error || "",' +
        '      shownErr3: errs[2].textContent,' +
        '      workletV3: wl2 && wl2[2] ? { enabled: wl2[2].enabled, src: wl2[2].src } : null,' +
        '      progress: log' +
        '    };' +
        '  } catch (err) {' +
        '    step("THREW: " + (err && err.message ? err.message : String(err)));' +
        '    return { progress: log };' +
        '  }' +
        '})()'
      );
    }).then(function () {
      // 4. 界面截图（探针模式：短暂显示窗口后抓图，供布局检查）
      if (!IS_PROBE) return;
      return new Promise(function (resolve) {
        mainWindow.show();
        setTimeout(function () {
          mainWindow.webContents.capturePage().then(function (img) {
            try {
              fs.writeFileSync(path.join(__dirname, '..', 'probe-shot.png'), img.toPNG());
              console.log('[probe] screenshot saved');
            } catch (err) {
              console.error('[probe] screenshot failed:', err && err.message);
            }
            resolve();
          }).catch(function (err) {
            console.error('[probe] screenshot failed:', err && err.message);
            resolve();
          });
        }, 800);
      });
    }).then(function () {
      finish();
    });
  });

  mainWindow.webContents.on('render-process-gone', function (_e, details) {
    console.error('[probe] RENDERER GONE:', JSON.stringify(details));
  });

  // 录音期间询问后再关闭
  mainWindow.on('close', function (e) {
    if (!recording) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '正在录制',
      message: '当前正在录制音频，确定要退出吗？',
      detail: '未导出的录音将会丢失。',
      buttons: ['取消', '仍然退出'],
      defaultId: 0,
      cancelId: 0
    });
    if (choice === 1) {
      recording = false;
      mainWindow.destroy();
    }
  });

  const saveTimer = setInterval(function () { saveWindowState(mainWindow); }, 2000);
  mainWindow.on('closed', function () {
    clearInterval(saveTimer);
    saveWindowState(mainWindow);
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  rebuildMenu();
}

/* ---------- IPC ---------- */
function ensureSender(event) {
  return mainWindow && event.sender === mainWindow.webContents;
}

function registerIpc() {
  // 页面按钮触发的原生打开对话框：返回 {path, name, data} 或 null
  ipcMain.handle('dialog:open', function (event, kind) {
    if (!ensureSender(event)) return null;
    return pickFile(kind === 'audio' ? 'audio' : 'midi');
  });

  // WAV 原生保存：renderer 传 ArrayBuffer
  ipcMain.handle('file:save', async function (event, payload) {
    if (!ensureSender(event) || !payload || !payload.data) return { ok: false };
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 WAV 音频',
      defaultPath: payload.suggestedName || 'lumiwave.wav',
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, Buffer.from(payload.data));
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('recent:list', function (event) {
    if (!ensureSender(event)) return [];
    return recentFiles.slice();
  });

  ipcMain.handle('recent:add', function (event, p) {
    if (!ensureSender(event) || typeof p !== 'string' || !p) return false;
    if (isMidi(p) || isAudio(p)) { pushRecent(p); return true; }
    return false;
  });

  ipcMain.handle('recent:clear', function (event) {
    if (!ensureSender(event)) return;
    recentFiles = [];
    saveRecentFiles();
    rebuildMenu();
  });

  // ---------- 收藏夹 / 文件夹浏览 ----------
  ipcMain.handle('dialog:open-dir', async function (event) {
    if (!ensureSender(event)) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择音乐文件夹',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    return { path: p, name: path.basename(p) || p };
  });

  ipcMain.handle('favorites:get', function (event) {
    if (!ensureSender(event)) return [];
    return loadFavorites();
  });

  ipcMain.handle('favorites:save', function (event, list) {
    if (!ensureSender(event) || !Array.isArray(list)) return null;
    return saveFavorites(list);
  });

  ipcMain.handle('dir:list', function (event, p) {
    if (!ensureSender(event)) return { error: '非法调用' };
    if (!validDirPath(p)) return { error: '无效的文件夹路径' };
    return listDirEntries(p);
  });

  ipcMain.handle('file:read-audio', function (event, p) {
    if (!ensureSender(event)) return { error: '非法调用' };
    if (!validDirPath(p)) return { error: '无效的文件路径' };
    return readAudioByPath(p);
  });

  // 录音状态同步（用于退出保护）
  ipcMain.on('app:recording', function (event, on) {
    if (!ensureSender(event)) return;
    recording = !!on;
  });

  // 播放状态同步（防节流 + 窗口标题）
  ipcMain.on('app:active', function (event, on) {
    if (!ensureSender(event)) return;
    setActive(!!on);
  });
}

/* ---------- 生命周期 ---------- */
// 探针模式绕过单实例锁：允许在用户实例运行时做无头冒烟测试
const gotLock = IS_PROBE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(function () {
    loadRecentFiles();
    registerIpc();
    createWindow();

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () {
    setActive(false);
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', function () { setActive(false); });
}
