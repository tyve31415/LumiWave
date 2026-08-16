/* 通用小工具 */

/** 秒 → m:ss 时间显示 */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/** 把 File / ArrayBuffer / TypedArray / Node Buffer 统一转为 ArrayBuffer */
export function toArrayBuffer(data) {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (typeof data.arrayBuffer === 'function') return data.arrayBuffer(); // File / Blob
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}
