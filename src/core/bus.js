/* 极简事件总线：模块间解耦通信（无循环依赖） */
'use strict';

const listeners = new Map();

export const bus = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => bus.off(type, fn);
  },
  off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  },
  emit(type, ...args) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(...args);
  }
};
