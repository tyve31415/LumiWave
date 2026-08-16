/* =========================================================
   LumiWave · Electron 预加载脚本
   通过 contextBridge 向渲染进程暴露最小化、类型清晰的 API
   ========================================================= */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** 是否为 Electron 桌面环境（浏览器中为 undefined） */
  isDesktop: true,

  /** 从拖拽/文件输入得到的 File 对象解析真实路径（用于最近文件） */
  getFilePath: function (file) {
    try { return webUtils.getPathForFile(file); } catch (err) { return null; }
  },

  /** 原生文件对话框（返回 {path, name, data: Uint8Array} 或 null） */
  openFileDialog: function (kind) { return ipcRenderer.invoke('dialog:open', kind); },

  /** 原生保存 WAV（返回 {ok, path | canceled | error}） */
  saveFile: function (payload) { return ipcRenderer.invoke('file:save', payload); },

  /** 最近文件 */
  getRecentFiles: function () { return ipcRenderer.invoke('recent:list'); },
  addRecentFile: function (p) { return ipcRenderer.invoke('recent:add', p); },
  clearRecentFiles: function () { return ipcRenderer.invoke('recent:clear'); },

  /** 收藏夹（音乐文件夹） */
  openDirectoryDialog: function () { return ipcRenderer.invoke('dialog:open-dir'); },
  favoritesGet: function () { return ipcRenderer.invoke('favorites:get'); },
  favoritesSave: function (list) { return ipcRenderer.invoke('favorites:save', list); },

  /** 文件夹浏览（资源管理器式收藏夹） */
  listDir: function (p) { return ipcRenderer.invoke('dir:list', p); },
  readAudioFile: function (p) { return ipcRenderer.invoke('file:read-audio', p); },

  /** 状态同步（退出保护 / 防节流） */
  setRecording: function (on) { ipcRenderer.send('app:recording', !!on); },
  setActive: function (on) { ipcRenderer.send('app:active', !!on); },

  /** 菜单命令订阅：返回取消订阅函数 */
  onMenuCommand: function (cb) {
    const listener = function (_e, cmd, arg) { cb(cmd, arg); };
    ipcRenderer.on('menu-command', listener);
    return function () { ipcRenderer.removeListener('menu-command', listener); };
  }
});
