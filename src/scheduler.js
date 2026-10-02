import { channelsExcluded } from './config.js';

// 相邻批次间所需的机时间隔：物镜切换成本与互斥通道冲洗取大者
export function gapBetween(cfg, a, b) {
  let g = 0;
  if (a.objective !== b.objective) g = Math.max(g, cfg.switchCost);
  if (channelsExcluded(cfg, a.channels, b.channels)) g = Math.max(g, cfg.channelFlush);
  return g;
}

function gapMatrix(cfg, batches) {
  return batches.map((a) => batches.map((b) => (a === b ? 0 : gapBetween(cfg, a, b))));
}

// 最优排序：n<=12 用子集 DP 求最小完工；在最优解之间用策略比较器裁决（含防抖动）
export function optimalOrder(cfg, batches, compare, maxConsecutive = Infinity) {
  const n = batches.length;
  if (n <= 1) return batches.slice();
  if (n > 12) return heuristicOrder(batches, compare);
  const f = batches.map((b) => b.fields);
  const gap = gapMatrix(cfg, batches);
  const N = 1 << n;
  const dp = Array.from({ length: N }, () => new Array(n).fill(Infinity));
  const rp = Array.from({ length: N }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) dp[1 << i][i] = f[i];
  for (let mask = 1; mask < N; mask++) {
    for (let i = 0; i < n; i++) {
      const cur = dp[mask][i];
      if (!isFinite(cur)) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const m2 = mask | (1 << j);
        const c = cur + f[j] + gap[i][j];
        if (c < dp[m2][j]) dp[m2][j] = c;
      }
    }
  }
  const full = N - 1;
  for (let i = 0; i < n; i++) rp[full][i] = 0;
  for (let mask = full - 1; mask >= 1; mask--) {
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const c = f[j] + gap[i][j] + rp[mask | (1 << j)][j];
        if (c < best) best = c;
      }
      rp[mask][i] = best;
    }
  }
  const opt = Math.min(...dp[full]);
  const order = [];
  let mask = 0;
  let last = -1;
  let costSoFar = 0;
  let consecGroup = null;
  let consecCount = 0;
  while (order.length < n) {
    const cands = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const add = f[j] + (last < 0 ? 0 : gap[last][j]);
      const m2 = mask | (1 << j);
      if (costSoFar + add + rp[m2][j] === opt) cands.push(j);
    }
    // 防抖动：同一课题组连续抢占达到上限时，若仍有其他组可保持最优则必须让位
    let pool = cands;
    if (consecGroup !== null && consecCount >= maxConsecutive) {
      const alt = cands.filter((j) => batches[j].group !== consecGroup);
      if (alt.length) pool = alt;
    }
    pool.sort((x, y) => compare(batches[x], batches[y]));
    const pick = pool[0];
    order.push(batches[pick]);
    costSoFar += f[pick] + (last < 0 ? 0 : gap[last][pick]);
    mask |= 1 << pick;
    if (batches[pick].group === consecGroup) consecCount++;
    else {
      consecGroup = batches[pick].group;
      consecCount = 1;
    }
    last = pick;
  }
  return order;
}

// n>12 的启发式：按物镜聚类，块间/块内按策略排序
function heuristicOrder(batches, compare) {
  const blocks = new Map();
  for (const b of batches) {
    if (!blocks.has(b.objective)) blocks.set(b.objective, []);
    blocks.get(b.objective).push(b);
  }
  for (const arr of blocks.values()) arr.sort(compare);
  const list = [...blocks.values()];
  list.sort((x, y) => compare(x[0], y[0]));
  return list.flat();
}

export function mergeIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end >= last.end) {
        last.end = iv.end;
        last.like = iv.like;
      }
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

// 求 [t0,horizon) 内扣除障碍后的空闲区间，每个区间携带其紧邻前一占用者的 like（物镜/通道）
export function freeIntervals(t0, horizon, obstacles) {
  const obs = mergeIntervals(obstacles).filter((o) => o.end >= t0 && o.start < horizon);
  const free = [];
  let cursor = t0;
  let like = null;
  let likeEnd = t0;
  for (const o of obs) {
    if (o.start > cursor) {
      free.push({ start: cursor, end: Math.min(o.start, horizon), like, likeEnd });
      cursor = o.end;
      like = o.like;
      likeEnd = o.end;
    } else if (o.end >= cursor) {
      cursor = Math.max(cursor, o.end);
      like = o.like;
      likeEnd = cursor;
    }
  }
  if (cursor < horizon) free.push({ start: cursor, end: horizon, like, likeEnd });
  return free;
}

// 按给定顺序在空闲区间布局，返回段列表；超出视界返回 null
export function layout(cfg, order, t0, obstacles, horizon) {
  const free = freeIntervals(t0, horizon, obstacles);
  const segs = [];
  let fi = 0;
  let curLike = free.length ? free[0].like : null;
  let curLikeEnd = free.length ? free[0].likeEnd : t0;
  let cursor = free.length ? free[0].start : t0;
  const advance = () => {
    fi++;
    if (fi < free.length) {
      curLike = free[fi].like;
      curLikeEnd = free[fi].likeEnd;
      cursor = free[fi].start;
    }
  };
  for (const b of order) {
    let need = b.fields;
    while (need > 0) {
      if (fi >= free.length) return null;
      const iv = free[fi];
      const gap = curLike ? gapBetween(cfg, curLike, b) : 0;
      const start = Math.max(cursor, curLikeEnd + gap);
      if (start >= iv.end) {
        advance();
        continue;
      }
      const len = Math.min(need, iv.end - start);
      segs.push({ batchId: b.id, start, fields: len });
      need -= len;
      cursor = start + len;
      curLike = b;
      curLikeEnd = cursor;
      if (cursor >= iv.end) advance();
    }
  }
  return segs;
}

// 枚举全部排列求最小完工（验收对照用）
export function bruteForceMinMakespan(cfg, batches) {
  const n = batches.length;
  if (n === 0) return 0;
  const f = batches.map((b) => b.fields);
  const gap = gapMatrix(cfg, batches);
  const a = batches.map((_, i) => i);
  const cost = () => {
    let c = 0;
    for (let k = 0; k < n; k++) {
      c += f[a[k]];
      if (k > 0) c += gap[a[k - 1]][a[k]];
    }
    return c;
  };
  let best = cost();
  const c = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      if (i % 2 === 0) [a[0], a[i]] = [a[i], a[0]];
      else [a[c[i]], a[i]] = [a[i], a[c[i]]];
      const v = cost();
      if (v < best) best = v;
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return best;
}
