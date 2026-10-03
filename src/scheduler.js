// 调度核心：纯函数，无副作用。
// 时间模型：整数分钟，t0 = 0。日历为若干 [start, end) 班次窗口，窗口之外即休息。
// 强制重置区间：绝对时间区间，区间内不可加工；时间线跨过该区间后累计寿命归零。
// 保养：占用 maintenanceMinutes 的班次时间，仅落在窗口内，与同模具其他事件顺序排列（天然不重叠）。

export function buildFreeIntervals(windows, resets = []) {
  const sortedWindows = [...windows].sort((a, b) => a.start - b.start);
  const sortedResets = [...resets].sort((a, b) => a.start - b.start);
  const free = [];
  for (const w of sortedWindows) {
    let segs = [{ start: w.start, end: w.end }];
    for (const r of sortedResets) {
      const next = [];
      for (const s of segs) {
        if (r.end <= s.start || r.start >= s.end) { next.push(s); continue; }
        if (s.start < r.start) next.push({ start: s.start, end: Math.min(s.end, r.start) });
        if (r.end < s.end) next.push({ start: Math.max(s.start, r.end), end: s.end });
      }
      segs = next;
    }
    free.push(...segs);
  }
  return free.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
}

function validateWindows(windows, moldId) {
  let prevEnd = null;
  for (const w of windows) {
    if (!(w.end > w.start)) {
      throw new Error(`mold ${moldId}: invalid calendar window [${w.start}, ${w.end})`);
    }
    if (prevEnd !== null && w.start < prevEnd) {
      throw new Error(`mold ${moldId}: overlapping calendar windows`);
    }
    prevEnd = w.end;
  }
}

// mold: { id, cycleMinutes, maintenanceMinutes, usedMinutes, calendar, resetIntervals }
// orders: [{ id, durationMinutes }] 按队列顺序
// 返回 { events, end, usedFinal }；events 为 maintenance / order 事件序列。
export function computeSchedule(mold, orders) {
  const moldId = mold.id ?? '?';
  const cycle = mold.cycleMinutes;
  const maint = mold.maintenanceMinutes;
  if (!(cycle > 0)) throw new Error(`mold ${moldId}: cycleMinutes must be > 0`);
  if (!(maint >= 0)) throw new Error(`mold ${moldId}: maintenanceMinutes must be >= 0`);
  const windows = [...(mold.calendar ?? [])].sort((a, b) => a.start - b.start);
  validateWindows(windows, moldId);
  const resets = [...(mold.resetIntervals ?? [])].sort((a, b) => a.start - b.start);
  for (const r of resets) {
    if (!(r.end > r.start)) throw new Error(`mold ${moldId}: invalid reset interval`);
  }
  const free = buildFreeIntervals(windows, resets);

  let used = mold.usedMinutes ?? 0;
  if (used < 0 || used > cycle) {
    throw new Error(`mold ${moldId}: usedMinutes ${used} out of range [0, ${cycle}]`);
  }

  const events = [];
  let cursor = 0;
  let freeIdx = 0;

  // 推进 cursor 到下一个可加工时刻；若跨过强制重置区间则寿命归零。
  const jumpToFree = () => {
    while (freeIdx < free.length && free[freeIdx].end <= cursor) freeIdx += 1;
    if (freeIdx >= free.length) { cursor = Infinity; return; }
    const target = Math.max(cursor, free[freeIdx].start);
    if (target > cursor) {
      for (const r of resets) {
        if (r.end > cursor && r.start < target) { used = 0; break; }
      }
    }
    cursor = target;
  };

  // 从 cursor 起、到下一次强制重置之前，可加工的分钟数。
  const workUntilReset = () => {
    let total = 0;
    let idx = freeIdx;
    let pos = cursor;
    for (;;) {
      const f = free[idx];
      total += f.end - pos;
      const nf = free[idx + 1];
      if (!nf) return total;
      const crossed = resets.some((r) => r.end > f.end && r.start < nf.start);
      if (crossed) return total;
      idx += 1;
      pos = nf.start;
    }
  };

  // 从 from 起在可加工时间内放置 duration 分钟，返回结束时刻（不足则 Infinity）。
  const placeEnd = (from, duration) => {
    let remaining = duration;
    let idx = freeIdx;
    while (idx < free.length && free[idx].end <= from) idx += 1;
    let pos = from;
    for (;;) {
      if (idx >= free.length) return Infinity;
      const f = free[idx];
      pos = Math.max(pos, f.start);
      const avail = f.end - pos;
      if (remaining <= avail) return pos + remaining;
      remaining -= avail;
      idx += 1;
      pos = f.end;
    }
  };

  for (const order of orders) {
    const dur = order.durationMinutes;
    if (!(dur > 0)) throw new Error(`order ${order.id}: durationMinutes must be > 0`);
    let remaining = dur;
    let start = null;
    for (;;) {
      jumpToFree();
      if (cursor === Infinity) {
        throw new Error(`mold ${moldId}: insufficient calendar for order ${order.id}`);
      }
      // 预检：若加工（到下一次重置前）会超过寿命上限，须先保养或等待强制重置。
      if (used > 0) {
        const wur = workUntilReset();
        if (used + Math.min(remaining, wur) > cycle) {
          const nextReset = resets.find((r) => r.end > cursor);
          const mEnd = placeEnd(cursor, maint);
          if (nextReset && nextReset.start < mEnd) {
            // 强制重置比保养更早到来：等待重置，寿命自然归零（更少调整）。
            cursor = nextReset.end;
            used = 0;
          } else {
            if (!(maint > 0)) {
              throw new Error(`mold ${moldId}: maintenance required for order ${order.id} but maintenanceMinutes is 0`);
            }
            if (mEnd === Infinity) {
              throw new Error(`mold ${moldId}: insufficient calendar for maintenance before order ${order.id}`);
            }
            events.push({ type: 'maintenance', moldId: mold.id, start: cursor, end: mEnd });
            cursor = mEnd;
            used = 0;
          }
          continue;
        }
      }
      const f = free[freeIdx];
      const take = Math.min(remaining, cycle - used, f.end - cursor);
      if (take <= 0) {
        throw new Error(`mold ${moldId}: scheduler made no progress on order ${order.id}`);
      }
      if (start === null) start = cursor;
      cursor += take;
      remaining -= take;
      used += take;
      if (remaining === 0) break;
    }
    events.push({ type: 'order', moldId: mold.id, orderId: order.id, start, end: cursor });
  }

  return { events, end: cursor, usedFinal: used };
}
