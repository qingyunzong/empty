'use strict';

const { CalendarError, ERR } = require('./errors');
const { subtractRange, byStart } = require('./intervals');

// 由日历定义在 [fromUtcMs, toUtcMs) 窗口内物化各资源的基准区间。
// calendar = {
//   shifts:     [{ id, resource, timezone, anchorLocalMs, periodMs, durationMs,
//                  fromLocalMs?, untilLocalMs?, status? }]
//   exceptions: [{ resource, startUtcMs, endUtcMs }]          // 停产例外，做减法
//   handovers:  [{ id, resource, startTimezone, endTimezone,
//                  startLocalMs, endLocalMs, status? }]       // 半时区交接区间
// }
// 返回 Map<resource, [{start,end,status,source}]>（按 start 排序，已减去例外）。
function generateCalendar(calendar, tzTables, fromUtcMs, toUtcMs) {
  const byResource = new Map();
  const push = (resource, iv) => {
    if (!byResource.has(resource)) byResource.set(resource, []);
    byResource.get(resource).push(iv);
  };

  for (const shift of calendar.shifts || []) {
    if (!Number.isFinite(shift.periodMs) || shift.periodMs <= 0) {
      throw new CalendarError(
        ERR.ZERO_PERIOD,
        `shift ${shift.id}: periodMs must be a positive number, got ${shift.periodMs}`,
        { shiftId: shift.id }
      );
    }
    if (!Number.isFinite(shift.durationMs) || shift.durationMs <= 0) {
      throw new CalendarError(
        ERR.INTERVAL_INVERSION,
        `shift ${shift.id}: durationMs must be positive, got ${shift.durationMs}`,
        { shiftId: shift.id }
      );
    }
    const table = tzTables[shift.timezone];
    if (!table) {
      throw new CalendarError(ERR.VALIDATION, `shift ${shift.id}: unknown timezone ${shift.timezone}`);
    }
    // 用表内偏移的极值把 UTC 窗口保守地映射到本地窗口，再逐枚举办班次。
    const localLo = fromUtcMs + table.minOffsetMinutes() * 60000;
    const localHi = toUtcMs + table.maxOffsetMinutes() * 60000;
    const anchor = shift.anchorLocalMs;
    const period = shift.periodMs;
    let k = Math.floor((localLo - anchor) / period) - 1;
    const kMax = Math.ceil((localHi - anchor) / period) + 1;
    for (; k <= kMax; k++) {
      const localStart = anchor + k * period;
      if (shift.fromLocalMs != null && localStart < shift.fromLocalMs) continue;
      if (shift.untilLocalMs != null && localStart >= shift.untilLocalMs) continue;
      const start = table.utcFromLocal(localStart);
      const end = start + shift.durationMs; // 时长为绝对时长，可跨越偏移切换
      if (end <= fromUtcMs || start >= toUtcMs) continue;
      push(shift.resource, {
        start,
        end,
        status: shift.status || 'shift',
        source: shift.id,
      });
    }
  }

  for (const h of calendar.handovers || []) {
    const startTable = tzTables[h.startTimezone];
    const endTable = tzTables[h.endTimezone];
    if (!startTable || !endTable) {
      throw new CalendarError(ERR.VALIDATION, `handover ${h.id}: unknown timezone`);
    }
    const start = startTable.utcFromLocal(h.startLocalMs);
    const end = endTable.utcFromLocal(h.endLocalMs);
    if (end <= start) {
      throw new CalendarError(
        ERR.INTERVAL_INVERSION,
        `handover ${h.id}: end (${end}) must be after start (${start})`,
        { handoverId: h.id }
      );
    }
    if (end <= fromUtcMs || start >= toUtcMs) continue;
    push(h.resource, { start, end, status: h.status || 'handover', source: h.id });
  }

  for (const ex of calendar.exceptions || []) {
    if (!(ex.endUtcMs > ex.startUtcMs)) {
      throw new CalendarError(
        ERR.INTERVAL_INVERSION,
        `exception on ${ex.resource}: endUtcMs must be after startUtcMs`
      );
    }
    const list = byResource.get(ex.resource);
    if (!list) continue;
    list.sort(byStart);
    subtractRange(list, ex.startUtcMs, ex.endUtcMs);
  }

  for (const list of byResource.values()) list.sort(byStart);
  return byResource;
}

module.exports = { generateCalendar };
