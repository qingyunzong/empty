import { deepClone, proofOf } from './util.js';
import { remaining, imagedRuns } from './state.js';
import { optimalOrder, layout, gapBetween, mergeIntervals } from './scheduler.js';
import { makeComparator } from './policy.js';
import { excludedPairWithin } from './config.js';
import * as E from './errors.js';

// 层级回滚的事务单元：每次变更产生一个批代际；失败则丢弃克隆，状态留在上一代际
export function transact(state, fn) {
  const next = deepClone(state);
  fn(next);
  next.generation = state.generation + 1;
  const proof = proofOf(next);
  next.generations.push({ gen: next.generation, proof, snapshot: snapshotOf(next) });
  return next;
}

function snapshotOf(s) {
  return deepClone({ clock: s.clock, batches: s.batches, segments: s.segments, maintenance: s.maintenance, groups: s.groups });
}

function batchLike(b) {
  return { objective: b.objective, channels: b.channels };
}

function obstaclesOf(state) {
  const obs = imagedRuns(state).map((r) => ({ start: r.start, end: r.end, like: r.like }));
  for (const w of state.maintenance) obs.push({ start: w.start, end: w.end, like: null });
  return obs;
}

// 全量重排待成像批次（预约与维护迁移共用）
export function replan(state) {
  const pending = Object.values(state.batches)
    .filter((b) => b.status === 'pending' && remaining(b) > 0)
    .map((b) => ({ id: b.id, group: b.group, objective: b.objective, channels: b.channels, fields: remaining(b), priority: b.priority }));
  const order = optimalOrder(state.config, pending, makeComparator(state), state.config.maxConsecutive);
  const segs = layout(state.config, order, state.clock, obstaclesOf(state), state.config.horizon);
  if (!segs) {
    throw E.infeasible('调度视界内无可行布局', { horizon: state.config.horizon, pendingBatches: pending.map((b) => b.id) });
  }
  state.segments = segs;
}

export function book(state, { id, group = 'default', objective, channels, fields, priority = 0 }) {
  if (!id) throw E.invalid('缺少批次 ID');
  if (state.batches[id]) throw E.invalid(`批次已存在: ${id}`, { id });
  if (!Number.isInteger(fields)) throw E.invalid('视野数须为整数', { fields });
  if (fields < 0) throw E.negativeFields(id, fields);
  if (fields === 0) throw E.invalid('视野数须为正', { fields });
  if (!state.config.objectives.includes(objective)) throw E.unknownObjective(objective);
  if (!Array.isArray(channels) || channels.length === 0) throw E.invalid('至少一个荧光通道', { id });
  for (const ch of channels) if (!state.config.channels.includes(ch)) throw E.unknownChannel(ch);
  const pair = excludedPairWithin(state.config, channels);
  if (pair) throw E.channelConflict(id, pair);
  if (!Number.isInteger(priority)) throw E.invalid('优先级须为整数', { priority });
  return transact(state, (s) => {
    s.batches[id] = { id, group, objective, channels, fieldsTotal: fields, fieldsImaged: 0, priority, status: 'pending' };
    s.groups[group] ??= { lastServedAt: -1 };
    replan(s);
  });
}

export function correct(state, id, delta) {
  const b = state.batches[id];
  if (!b) throw E.unknownBatch(id);
  if (!Number.isInteger(delta) || delta === 0) throw E.invalid('更正量须为非零整数', { delta });
  const newTotal = b.fieldsTotal + delta;
  if (newTotal < 0) throw E.negativeFields(id, newTotal);
  if (newTotal < b.fieldsImaged) {
    throw E.immutable(`更正后视野 ${newTotal} 少于已出具图像 ${b.fieldsImaged}，已出具图像不可改`, { id, imaged: b.fieldsImaged });
  }
  return transact(state, (s) => {
    const batch = s.batches[id];
    batch.fieldsTotal = newTotal;
    if (batch.status === 'done' && remaining(batch) > 0) batch.status = 'pending';
    if (delta < 0) releaseFields(s, batch, -delta);
    else appendFields(s, batch, delta);
  });
}

// 减少视野：从该批最新（末尾）的未成像段释放机时
function releaseFields(s, batch, count) {
  let toFree = count;
  const mine = s.segments.filter((sg) => sg.batchId === batch.id).sort((a, b2) => b2.start - a.start);
  for (const sg of mine) {
    if (toFree === 0) break;
    const take = Math.min(sg.fields, toFree);
    sg.fields -= take;
    toFree -= take;
  }
  if (toFree > 0) throw E.infeasible('可释放的未成像视野不足', { id: batch.id });
  s.segments = s.segments.filter((sg) => sg.fields > 0);
}

// 增加视野：只追加可行段，不移动任何既有段
function appendFields(s, batch, count) {
  const cfg = s.config;
  const like = batchLike(batch);
  const occ = allOccupied(s);
  const ownEnd = s.segments.filter((sg) => sg.batchId === batch.id).reduce((m, sg) => Math.max(m, sg.start + sg.fields), 0);
  const ownImagedEnd = s.imaged.filter((f) => f.batchId === batch.id).reduce((m, f) => Math.max(m, f.slot + 1), 0);
  const startPoint = Math.max(s.clock, ownEnd, ownImagedEnd);
  let i = occ.findIndex((o) => o.end > startPoint);
  if (i === -1) i = occ.length;
  let prevLike = i > 0 ? occ[i - 1].like : null;
  let prevEnd = i > 0 ? occ[i - 1].end : startPoint;
  let cursor = startPoint;
  let need = count;
  const added = [];
  while (need > 0) {
    const next = i < occ.length ? occ[i] : null;
    const gapBefore = prevLike ? gapBetween(cfg, prevLike, like) : 0;
    const start = Math.max(cursor, prevEnd + gapBefore);
    const gapAfter = next && next.like ? gapBetween(cfg, like, next.like) : 0;
    const limit = (next ? next.start : cfg.horizon) - gapAfter;
    const avail = limit - start;
    if (avail > 0) {
      const len = Math.min(need, avail);
      added.push({ batchId: batch.id, start, fields: len });
      need -= len;
      prevLike = like;
      prevEnd = start + len;
      cursor = prevEnd;
      if (need > 0) {
        if (!next) break;
        prevLike = next.like;
        prevEnd = next.end;
        cursor = next.end;
        i++;
      }
    } else {
      if (!next) break;
      prevLike = next.like;
      prevEnd = next.end;
      cursor = next.end;
      i++;
    }
  }
  if (need > 0) {
    throw E.infeasible(`追加可行段失败: 批次 ${batch.id} 尚有 ${need} 视野无法安置`, { id: batch.id, requested: count });
  }
  s.segments.push(...added);
  s.segments.sort((a, b2) => a.start - b2.start);
}

function allOccupied(s) {
  const occ = s.segments.map((sg) => {
    const b = s.batches[sg.batchId];
    return { start: sg.start, end: sg.start + sg.fields, like: batchLike(b) };
  });
  for (const r of imagedRuns(s)) occ.push({ start: r.start, end: r.end, like: r.like });
  for (const w of s.maintenance) occ.push({ start: w.start, end: w.end, like: null });
  return mergeIntervals(occ);
}

export function maintain(state, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) {
    throw E.invalid('维护窗口非法', { start, end });
  }
  for (const w of state.maintenance) {
    if (start < w.end && end > w.start) throw E.maintenanceOverlap({ start, end }, w);
  }
  const hit = state.imaged.filter((f) => f.slot >= start && f.slot < end);
  if (hit.length) {
    throw E.immutable(`维护窗口 [${start},${end}) 覆盖已出具图像（${hit.length} 视野），已出具图像不可改`, { start, end, imagedSlots: hit.length });
  }
  return transact(state, (s) => {
    s.maintenance.push({ start, end });
    s.maintenance.sort((a, b) => a.start - b.start);
    const affected = s.segments.filter((sg) => sg.start < end && sg.start + sg.fields > start).map((sg) => sg.batchId);
    try {
      replan(s);
    } catch (e) {
      if (e instanceof E.SchedError) throw E.migrationFailed({ start, end }, [...new Set(affected)]);
      throw e;
    }
  });
}

export function cancel(state, id) {
  const b = state.batches[id];
  if (!b || b.status === 'cancelled') throw E.unknownBatch(id);
  if (b.fieldsImaged > 0 && remaining(b) === 0) {
    throw E.immutable(`批次 ${id} 已全部成像，已出具图像不可改`, { id });
  }
  return transact(state, (s) => {
    s.segments = s.segments.filter((sg) => sg.batchId !== id);
    const batch = s.batches[id];
    if (batch.fieldsImaged === 0) {
      delete s.batches[id];
    } else {
      batch.fieldsTotal = batch.fieldsImaged;
      batch.status = 'cancelled';
    }
  });
}

export function scan(state, until = null) {
  const limit = until == null ? Infinity : until;
  if (!(limit > state.clock - 1) && until != null) throw E.invalid('扫描截止时刻非法', { until });
  return transact(state, (s) => {
    const newSegs = [];
    for (const seg of s.segments.slice().sort((a, b) => a.start - b.start)) {
      const batch = s.batches[seg.batchId];
      const imaging = Math.max(0, Math.min(seg.fields, limit - seg.start));
      for (let slot = seg.start; slot < seg.start + imaging; slot++) {
        s.imaged.push({ batchId: batch.id, slot, group: batch.group, objective: batch.objective, channels: batch.channels });
        s.groups[batch.group].lastServedAt = slot;
        batch.fieldsImaged++;
        s.clock = Math.max(s.clock, slot + 1);
      }
      const rest = seg.fields - imaging;
      if (rest > 0) newSegs.push({ batchId: seg.batchId, start: seg.start + imaging, fields: rest });
      if (remaining(batch) === 0) batch.status = 'done';
    }
    s.segments = newSegs;
  });
}

// 层级回滚：恢复到指定批代际的调度视图；已出具图像（imaged 日志）不可改、不回滚
export function rollbackTo(state, gen) {
  const entry = state.generations.find((g) => g.gen === gen);
  if (!entry) throw E.noGeneration(gen);
  return transact(state, (s) => {
    const snap = deepClone(entry.snapshot);
    const imagedCount = {};
    for (const f of s.imaged) imagedCount[f.batchId] = (imagedCount[f.batchId] || 0) + 1;
    s.maintenance = snap.maintenance;
    s.groups = snap.groups;
    s.batches = {};
    for (const [id, b] of Object.entries(snap.batches)) {
      const img = imagedCount[id] || 0;
      const status = img >= b.fieldsTotal ? 'done' : b.status === 'done' ? 'pending' : b.status;
      s.batches[id] = { ...b, fieldsImaged: img, status };
    }
    replan(s);
  });
}
