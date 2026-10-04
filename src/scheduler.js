// Deterministic slot scheduler for unit-size margin-call tasks with deadlines.
//
// Tasks are considered in rank order (priority desc, gap desc, liquidation
// distance asc, account id asc) and each is placed at the LATEST free slot
// not exceeding its deadline. For unit tasks with deadlines this greedy is
// optimal: when capacity is scarce, higher-ranked tasks (higher priority,
// then higher gap) occupy the slots and lower-ranked tasks are preempted
// (rejected with NO_CAPACITY, recording which occupant preempted them).

export function liquidationDistance(task) {
  return task.equity - task.liquidationLine;
}

export function compareRank(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.gap !== b.gap) return b.gap - a.gap;
  const da = liquidationDistance(a);
  const db = liquidationDistance(b);
  if (da !== db) return da - db;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function scheduleCalls(tasks, config) {
  const slots = config.slots;
  const capacity = config.slotCapacity ?? 1;
  const sorted = [...tasks].sort(compareRank);
  const loads = new Array(slots + 1).fill(0); // 1-based slot indices
  const occupants = new Map(); // slot -> task[]
  const scheduled = [];
  const errors = [];

  const place = (task, slot) => {
    loads[slot] += 1;
    if (!occupants.has(slot)) occupants.set(slot, []);
    occupants.get(slot).push(task);
    scheduled.push({
      accountId: task.id,
      slot,
      gap: task.gap,
      equity: task.equity,
      price: task.price,
      version: task.version,
      priority: task.priority,
    });
  };

  for (const task of sorted) {
    const latest = Math.min(task.deadlineSlot, slots);
    let slot = null;
    for (let s = latest; s >= 1; s--) {
      if (loads[s] < capacity) {
        slot = s;
        break;
      }
    }
    if (slot !== null) {
      place(task, slot);
      continue;
    }
    // No feasible capacity: every slot up to the deadline is full of tasks
    // that all rank strictly above this one (rank-ordered greedy invariant).
    // Report the lowest-ranked such occupant as the preempting task.
    let preemptedBy = null;
    for (let s = 1; s <= latest; s++) {
      for (const occ of occupants.get(s) ?? []) {
        if (preemptedBy === null || compareRank(occ, preemptedBy) > 0) preemptedBy = occ;
      }
    }
    const err = { code: 'NO_CAPACITY', accountId: task.id };
    if (preemptedBy !== null) err.preemptedBy = preemptedBy.id;
    errors.push(err);
  }

  scheduled.sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
  return { scheduled, errors };
}
