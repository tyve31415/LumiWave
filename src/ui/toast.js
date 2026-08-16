/* =========================================================
   Toast 轻提示：非阻塞的成功/信息反馈（自动消失）
   ========================================================= */
'use strict';

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * @param {string} msg 消息内容
 * @param {'info'|'success'|'error'} kind 类型
 * @param {number} duration 显示毫秒
 */
export function toast(msg, kind = 'info', duration = 3200) {
  const box = ensureContainer();
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  // 触发进入动画
  requestAnimationFrame(function () { t.classList.add('show'); });
  setTimeout(function () {
    t.classList.remove('show');
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 300);
  }, duration);
}
