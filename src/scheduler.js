import { transitionCost, quotaOf } from './model.js';
import { MicError } from './util.js';

export function plannedCount(batch) {
  return batch.segments.reduce((s, seg) => s + seg.count, 0);
}

export function demandOf(batch) {
  return batch.fovs - batch.imaged - plannedCount(batch);
}

export function lastScanSlot(state) {
  for (let s = state.slots.length - 1; s >= 0; s--) {
    if (state.slots[s] && state.slots[s].t === 'scan') return s;
  }
  return -1;
}

function lastServedOf(state, group) {
  return state.groupLastServed[group] ?? -1;
}

// 接纳排序:优先级降序 -> 最久未服务课题组 -> 批 ID 升序(同优先级同配额按批 ID)
export function compareCandidates(state) {
  return (a, b) =>
    b.priority - a.priority ||
    lastServedOf(state, a.group) - lastServedOf(state, b.group) ||
    a.num - b.num;
}

// 接纳:配额约束 + 连续抢占上限(防抖动)
export function admit(state) {
  const cfg = state.config;
  const candidates = Object.values(state.batches)
    .filter((b) => b.status !== 'cancelled' && demandOf(b) > 0)
    .sort(compareCandidates(state));
  const groups = new Set(candidates.map((b) => b.group));
  const quotaUsed = {};
  const admitted = [];
  const explanations = [];
  let consecGroup = null;
  let consecCount = 0;
  for (const b of candidates) {
    const need = demandOf(b);
    const quota = quotaOf(state, b.group);
    const used = quotaUsed[b.group] ?? 0;
    if (used + need > quota) {
      explanations.push(`未接纳 ${b.id}: 课题组 ${b.group} 配额不足 (本轮已用 ${used}/${quota}, 需求 ${need} 视野)`);
      continue;
    }
    if (b.group === consecGroup && consecCount >= cfg.maxConsecutivePreemptions && groups.size > 1) {
      explanations.push(`未接纳 ${b.id}: 课题组 ${b.group} 已达连续抢占上限 ${cfg.maxConsecutivePreemptions}, 防抖动让位其他课题组`);
      continue;
    }
    admitted.push(b);
    quotaUsed[b.group] = used + need;
    if (b.group === consecGroup) consecCount += 1;
    else { consecGroup = b.group; consecCount = 1; }
  }
  return { admitted, explanations };
}

// 排序:最小化总转换成本(=最小完工)。组数 <= 16 用 Held-Karp 精确 DP,否则贪心。
export function sequenceChunks(state, prevBatch, batches) {
  const m = batches.length;
  if (m <= 1) return batches.slice();
  const cfg = state.config;
  if (m > 16) return greedyOrder(state, prevBatch, batches);
  const N = 1 << m;
  const dp = new Array(N);
  const parent = new Array(N);
  for (let mask = 0; mask < N; mask++) {
    dp[mask] = new Array(m).fill(Infinity);
    parent[mask] = new Array(m).fill(-1);
  }
  for (let i = 0; i < m; i++) dp[1 << i][i] = transitionCost(cfg, prevBatch, batches[i]);
  for (let mask = 1; mask < N; mask++) {
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask][j];
      if (cur === Infinity) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const v = cur + transitionCost(cfg, batches[j], batches[k]);
        if (v < dp[nm][k]) { dp[nm][k] = v; parent[nm][k] = j; }
      }
    }
  }
  const full = N - 1;
  let best = 0;
  for (let j = 1; j < m; j++) if (dp[full][j] < dp[full][best]) best = j;
  const order = [];
  let mask = full;
  let j = best;
  while (j !== -1) {
    order.push(batches[j]);
    const pj = parent[mask][j];
    mask ^= 1 << j;
    j = pj;
  }
  return order.reverse();
}

function greedyOrder(state, prevBatch, batches) {
  const remaining = batches.slice();
  const order = [];
  let prev = prevBatch;
  while (remaining.length) {
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = transitionCost(state.config, prev, remaining[i]);
      if (c < bestCost) { bestCost = c; bestIdx = i; }
    }
    const [next] = remaining.splice(bestIdx, 1);
    order.push(next);
    prev = next;
  }
  return order;
}

// 槽位 s 能否放置 batch 的视野:检查与前后相邻扫描槽的转换间隔
export function canPlaceAt(state, s, batch) {
  const slots = state.slots;
  if (s < 0 || s >= slots.length || slots[s] !== null) return false;
  for (let p = s - 1; p >= 0; p--) {
    const sl = slots[p];
    if (sl && sl.t === 'scan') {
      if (sl.batch !== batch.id) {
        const need = transitionCost(state.config, state.batches[sl.batch], batch);
        if (s - p - 1 < need) return false;
      }
      break;
    }
  }
  for (let n = s + 1; n < slots.length; n++) {
    const sl = slots[n];
    if (sl && sl.t === 'scan') {
      if (sl.batch !== batch.id) {
        const need = transitionCost(state.config, batch, state.batches[sl.batch]);
        if (n - s - 1 < need) return false;
      }
      break;
    }
  }
  return true;
}

// 为 batch 放置 count 个视野(各自占 1 槽),自 fromSlot 起取最早可行槽。
// partial=true 时允许部分放置(返回 shortfall);否则不足即抛错并自清理。
export function placeFovs(state, batch, count, fromSlot, { partial = false } = {}) {
  const H = state.slots.length;
  const placedSlots = [];
  const segLenBefore = batch.segments.length;
  const lastSegCountBefore = segLenBefore > 0 ? batch.segments[segLenBefore - 1].count : 0;
  let nextFov = batch.imaged + plannedCount(batch) + 1;
  let remaining = count;
  let s = Math.max(fromSlot, 0);
  while (remaining > 0 && s < H) {
    if (canPlaceAt(state, s, batch)) {
      state.slots[s] = { t: 'scan', batch: batch.id, fov: nextFov, imaged: false };
      const last = batch.segments[batch.segments.length - 1];
      if (last && last.start + last.count === s) last.count += 1;
      else batch.segments.push({ start: s, count: 1 });
      placedSlots.push(s);
      nextFov += 1;
      remaining -= 1;
    }
    s += 1;
  }
  if (remaining > 0 && !partial) {
    for (const slot of placedSlots) state.slots[slot] = null;
    batch.segments.length = segLenBefore;
    if (segLenBefore > 0) batch.segments[segLenBefore - 1].count = lastSegCountBefore;
    throw new MicError(`机时不足: 批次 ${batch.id} 尚需 ${remaining} 个视野槽位 (自槽位 ${fromSlot} 起)`, 1);
  }
  return { placed: placedSlots.length, shortfall: remaining };
}

// 原子放置一组块;失败则整体回滚
export function placeSequence(state, chunks, fromSlot) {
  const slotsSnapshot = state.slots.slice();
  const segSnapshots = new Map(chunks.map((c) => [c.batch.id, c.batch.segments.map((s) => ({ ...s }))]));
  try {
    for (const c of chunks) placeFovs(state, c.batch, c.count, fromSlot);
  } catch (e) {
    state.slots = slotsSnapshot;
    for (const c of chunks) {
      const seg = segSnapshots.get(c.batch.id);
      if (seg) c.batch.segments = seg;
    }
    throw e;
  }
}

// 压缩:将全部未出图计划段按原相对次序从 now 起重排,释放机时。
// 回滚以批代际为单位(整批计划段重排),已出图槽位冻结不动。
export function compact(state) {
  const entries = [];
  for (let s = state.now; s < state.slots.length; s++) {
    const sl = state.slots[s];
    if (sl && sl.t === 'scan' && !sl.imaged) entries.push({ batchId: sl.batch, slot: s });
  }
  if (entries.length === 0) return;
  const chunks = [];
  for (const e of entries) {
    const last = chunks[chunks.length - 1];
    if (last && last.batch.id === e.batchId) last.count += 1;
    else chunks.push({ batch: state.batches[e.batchId], count: 1 });
  }
  const slotsSnapshot = state.slots.slice();
  const segSnapshots = new Map(chunks.map((c) => [c.batch.id, c.batch.segments.map((s) => ({ ...s }))]));
  for (const e of entries) state.slots[e.slot] = null;
  for (const c of chunks) c.batch.segments = [];
  try {
    for (const c of chunks) placeFovs(state, c.batch, c.count, state.now);
  } catch (e) {
    state.slots = slotsSnapshot;
    for (const c of chunks) c.batch.segments = segSnapshots.get(c.batch.id);
    throw new MicError(`压缩失败: 无法在不违反通道互斥的前提下释放机时 (${e.message})`, 1);
  }
}

// 校验调度不变量:相邻异批扫描槽间隔 >= 转换成本(通道互斥/物镜切换不被侵犯)
export function verifySchedule(state) {
  const violations = [];
  let prev = null;
  for (let s = 0; s < state.slots.length; s++) {
    const sl = state.slots[s];
    if (!sl || sl.t !== 'scan') continue;
    if (prev && prev.batchId !== sl.batch) {
      const need = transitionCost(state.config, state.batches[prev.batchId], state.batches[sl.batch]);
      const gap = s - prev.slot - 1;
      if (gap < need) {
        violations.push(`槽位 ${prev.slot}(${prev.batchId}) 与 ${s}(${sl.batch}) 间隔 ${gap} < 所需 ${need}`);
      }
    }
    prev = { slot: s, batchId: sl.batch };
  }
  return violations;
}
