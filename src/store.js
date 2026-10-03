'use strict';

const { overlaps, firstOverlapMs, subtractRange, sortedInsert } = require('./intervals');

// 版本化区间存储：每条区间记录写入它的 commandId 与 version。
// 全局单调版本号；命令带 baseVersion，仅当与其区间相交的区间
// 由 version > baseVersion 的命令写入时判定 REVISION 冲突。
class Store {
  constructor() {
    this.version = 0;
    this.resources = new Map(); // resource -> sorted interval list
  }

  list(resource) {
    if (!this.resources.has(resource)) this.resources.set(resource, []);
    return this.resources.get(resource);
  }

  nextVersion() {
    return ++this.version;
  }

  // 返回 null 表示无冲突；否则返回 { interval, firstOverlapMs }，
  // 其中 firstOverlapMs 为所有冲突区间中最早的重叠毫秒。
  findConflict(resource, start, end, baseVersion) {
    let best = null;
    for (const iv of this.list(resource)) {
      if (iv.end <= start) continue;
      if (iv.start >= end) break;
      if (iv.version > baseVersion) {
        const ms = firstOverlapMs(start, end, iv.start, iv.end);
        if (!best || ms < best.firstOverlapMs) {
          best = { interval: iv, firstOverlapMs: ms };
        }
      }
    }
    return best;
  }

  // 以下写操作返回 undo 记录，供事务回滚使用。

  insert(resource, interval) {
    const list = this.list(resource);
    sortedInsert(list, interval);
    return { kind: 'insert', resource, interval };
  }

  subtract(resource, start, end) {
    const list = this.list(resource);
    const { removed, added } = subtractRange(list, start, end);
    return { kind: 'subtract', resource, removed, added };
  }

  applyUndo(undo) {
    const list = this.list(undo.resource);
    if (undo.kind === 'insert') {
      const idx = list.indexOf(undo.interval);
      if (idx >= 0) list.splice(idx, 1);
    } else {
      // 撤销 subtract：移除残段，复原被删区间。
      for (const piece of undo.added) {
        const idx = list.indexOf(piece);
        if (idx >= 0) list.splice(idx, 1);
      }
      for (const iv of undo.removed) sortedInsert(list, iv);
    }
  }

  snapshot(resource) {
    return this.list(resource).map((iv) => ({ ...iv }));
  }
}

module.exports = { Store, overlaps };
