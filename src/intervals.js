'use strict';

// 区间统一为左闭右开 [start, end)，单位为 UTC 毫秒。

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// 调用前必须保证 overlaps(...) 为真；返回首个重叠毫秒。
function firstOverlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart);
}

function byStart(a, b) {
  return a.start - b.start;
}

// 从按 start 排序的区间列表中减去 [start, end)。
// 返回 { removed: [...], added: [...] }：removed 为被整体移除的原区间对象，
// added 为裁剪后重新插入的残段。列表本身被原地修改。
function subtractRange(list, start, end) {
  const removed = [];
  const added = [];
  const kept = [];
  for (const iv of list) {
    if (iv.end <= start || iv.start >= end) {
      kept.push(iv);
      continue;
    }
    removed.push(iv);
    if (iv.start < start) {
      added.push({ ...iv, end: start });
    }
    if (iv.end > end) {
      added.push({ ...iv, start: end });
    }
  }
  kept.push(...added);
  kept.sort(byStart);
  list.length = 0;
  list.push(...kept);
  return { removed, added };
}

// 在已排序列表中按 start 有序插入（允许区间互相重叠）。
function sortedInsert(list, interval) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= interval.start) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, interval);
}

module.exports = { overlaps, firstOverlapMs, subtractRange, sortedInsert, byStart };
