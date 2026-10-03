// 对照用的小规模暴力算法：枚举“在每个工单之前是否插入保养”的全部位置组合，
// 在可行方案中取保养次数最少、再取最早完工者。用于交叉验证库实现的贪心调度。
import { buildFreeIntervals } from '../src/scheduler.js';

export function bruteForceSchedule(mold, orders) {
  const cycle = mold.cycleMinutes;
  const maint = mold.maintenanceMinutes;
  const free = buildFreeIntervals(mold.calendar, mold.resetIntervals ?? []);

  const place = (from, duration) => {
    let remaining = duration;
    let idx = free.findIndex((f) => f.end > from);
    let pos = from;
    for (;;) {
      if (idx === -1 || idx >= free.length) return Infinity;
      const f = free[idx];
      pos = Math.max(pos, f.start);
      const avail = f.end - pos;
      if (remaining <= avail) return pos + remaining;
      remaining -= avail;
      idx += 1;
      pos = f.end;
    }
  };

  const n = orders.length;
  let best = null;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    let used = mold.usedMinutes ?? 0;
    let cursor = 0;
    let count = 0;
    let feasible = true;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) {
        cursor = place(cursor, maint);
        if (cursor === Infinity) { feasible = false; break; }
        used = 0;
        count += 1;
      }
      if (used + orders[i].durationMinutes > cycle) { feasible = false; break; }
      cursor = place(cursor, orders[i].durationMinutes);
      if (cursor === Infinity) { feasible = false; break; }
      used += orders[i].durationMinutes;
    }
    if (!feasible) continue;
    const cand = { maintenances: count, end: cursor };
    if (!best
        || cand.maintenances < best.maintenances
        || (cand.maintenances === best.maintenances && cand.end < best.end)) {
      best = cand;
    }
  }
  return best;
}

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeMold(overrides = {}) {
  return {
    id: 'M1',
    cycleMinutes: 100,
    maintenanceMinutes: 20,
    usedMinutes: 0,
    calendar: [{ start: 0, end: 100000 }],
    resetIntervals: [],
    ...overrides,
  };
}

export function maintEvents(sched) {
  return sched.events.filter((e) => e.type === 'maintenance');
}

export function orderEvents(sched) {
  return sched.events.filter((e) => e.type === 'order');
}
