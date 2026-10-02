// Pure, deterministic slot scheduler.
// Ranking: priority desc, then gap desc, then liquidation distance asc, then account id asc.

export function compareTasks(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.gap !== b.gap) return b.gap - a.gap;
  if (a.liqDistance !== b.liqDistance) return a.liqDistance - b.liqDistance;
  if (a.accountId < b.accountId) return -1;
  if (a.accountId > b.accountId) return 1;
  return 0;
}

export function scheduleTasks(tasks, slots, slotCapacity = 1) {
  const ranked = [...tasks].sort(compareTasks);
  const load = new Array(slots).fill(0);
  const calls = [];
  const errors = [];
  for (const task of ranked) {
    const last = Math.min(task.deadlineSlot, slots - 1);
    let slot = -1;
    for (let s = 0; s <= last; s += 1) {
      if (load[s] < slotCapacity) {
        slot = s;
        break;
      }
    }
    if (slot === -1) {
      errors.push({ code: 'NO_CAPACITY', accountId: task.accountId, deadlineSlot: task.deadlineSlot });
      continue;
    }
    load[slot] += 1;
    calls.push({
      accountId: task.accountId,
      slot,
      priority: task.priority,
      gap: task.gap,
      liqDistance: task.liqDistance,
      equity: task.equity,
      deadlineSlot: task.deadlineSlot,
    });
  }
  calls.sort((a, b) => a.slot - b.slot || compareTasks(a, b));
  return { calls, errors };
}
