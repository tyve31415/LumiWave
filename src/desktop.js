/* =========================================================
   Electron 桌面桥接层：window.desktop（预加载脚本注入）的
   类型化封装。若预加载异常缺失，所有调用安全降级为空操作。
   ========================================================= */
'use strict';

const api = window.desktop;
const hasDesktop = !!(api && api.isDesktop);

const desktop = {
  isDesktop: hasDesktop,

  /** 从 File 对象解析真实磁盘路径（用于最近文件） */
  getFilePath(file) {
    if (!hasDesktop || !file) return null;
    try { return api.getFilePath(file); } catch (err) { return null; }
  },

  /** 订阅系统菜单命令；返回取消订阅函数 */
  onMenuCommand(cb) {
    if (!hasDesktop) return function () {};
    return api.onMenuCommand(cb);
  },

  /** 原生打开文件对话框（返回 {path, name, data} 或 null） */
  openFileDialog(kind) {
    if (!hasDesktop) return Promise.resolve(null);
    return api.openFileDialog(kind);
  },

  /** 原生保存 WAV（返回 {ok, path | canceled | error} 或 null） */
  saveFile(payload) {
    if (!hasDesktop) return Promise.resolve(null);
    return api.saveFile(payload);
  },

  /** 记录最近文件（拖放导入时使用真实路径） */
  addRecentFile(p) {
    if (!hasDesktop || !p) return Promise.resolve(false);
    return api.addRecentFile(p);
  },

  /** 原生选择文件夹对话框（收藏夹用，返回 {path, name} 或 null） */
  openDirectoryDialog() {
    if (!hasDesktop) return Promise.resolve(null);
    return api.openDirectoryDialog();
  },

  /** 收藏夹读写（音乐文件夹列表） */
  favoritesGet() {
    if (!hasDesktop) return Promise.resolve([]);
    return api.favoritesGet();
  },
  favoritesSave(list) {
    if (!hasDesktop) return Promise.resolve(null);
    return api.favoritesSave(list);
  },

  /** 列出文件夹内容（{dirs, files} 或 {error}） */
  listDir(p) {
    if (!hasDesktop) return Promise.resolve({ error: '文件夹浏览仅在桌面版可用' });
    return api.listDir(p);
  },

  /** 读取音频文件内容（{name, data: Uint8Array} 或 {error}） */
  readAudioFile(p) {
    if (!hasDesktop) return Promise.resolve({ error: '文件读取仅在桌面版可用' });
    return api.readAudioFile(p);
  },

  /** 录音状态同步（退出保护） */
  setRecording(on) {
    if (hasDesktop) api.setRecording(!!on);
  },

  /** 播放状态同步（防 CPU 节流） */
  setActive(on) {
    if (hasDesktop) api.setActive(!!on);
  }
};

export default desktop;
