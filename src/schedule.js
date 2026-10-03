export function shiftMinutes(shift) {
  const [sh, sm] = shift.start.split(':').map(Number);
  const [eh, em] = shift.end.split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // crosses midnight
  return mins;
}

export function crossesMidnight(shift) {
  return shift.end <= shift.start;
}

export function buildSchedule(config, state) {
  const remaining = {};
  for (const [wc, shifts] of Object.entries(config.capabilities)) {
    remaining[wc] = { ...shifts };
  }
  const queue = [];
  const unscheduled = [];
  const scheduleBreaches = [];
  const shiftIndex = new Map(config.calendar.shifts.map((s, i) => [s.id, i]));
  const eligible = config.orders
    .filter((o) => state.isReleasable(o.id))
    .map((o) => ({ order: o, shiftId: state.derived.resched[o.id] ?? o.dueShift }))
    .sort(
      (a, b) =>
        (shiftIndex.get(a.shiftId) ?? 99) - (shiftIndex.get(b.shiftId) ?? 99) ||
        a.order.id.localeCompare(b.order.id),
    );
  for (const { order, shiftId } of eligible) {
    const need = order.minutes ?? 0;
    const rem = remaining[order.workCenter]?.[shiftId];
    const shift = config.calendar.shifts.find((s) => s.id === shiftId);
    if (rem === undefined || !shift) {
      unscheduled.push({ orderId: order.id, reason: 'unknown-shift-or-workcenter', shift: shiftId });
      scheduleBreaches.push({ type: 'unknown-shift', orderId: order.id, shift: shiftId });
      continue;
    }
    if (rem >= need) {
      remaining[order.workCenter][shiftId] -= need;
      queue.push({
        orderId: order.id,
        shift: shiftId,
        workCenter: order.workCenter,
        minutes: need,
        start: shift.start,
        end: shift.end,
        crossesMidnight: crossesMidnight(shift),
      });
    } else {
      unscheduled.push({ orderId: order.id, reason: 'capability-insufficient', shift: shiftId, need, remaining: rem });
      scheduleBreaches.push({ type: 'capability-insufficient', orderId: order.id, shift: shiftId, need, remaining: rem });
    }
  }
  return { date: config.calendar.date, queue, unscheduled, remainingCapability: remaining, scheduleBreaches };
}
