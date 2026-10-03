// Independent verifier. Given a parsed instance and a solution object it
// re-checks every reported fact and returns an item-by-item certificate:
// { ok, checks: [{ id, ok, detail }] }. The solver attaches this certificate
// to its output; the CLI `verify` command re-computes it.

export function verifySolution(inst, sol) {
  const checks = [];
  const add = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail });

  const now = inst.now;
  const H = inst.shifts.length > 0 ? Math.max(...inst.shifts.map((s) => s.end)) : 0;
  const shiftOf = new Int32Array(Math.max(H, 1)).fill(-1);
  inst.shifts.forEach((s, si) => {
    for (let t = Math.max(s.start, now); t < s.end; t += 1) shiftOf[t] = si;
  });
  const orderById = new Map(inst.orders.map((o) => [o.id, o]));
  const machineIndex = new Map(inst.machines.map((id, i) => [id, i]));

  const shapeOk =
    sol !== null &&
    typeof sol === 'object' &&
    sol.status === 'optimal' &&
    Array.isArray(sol.orders) &&
    Array.isArray(sol.machines) &&
    Array.isArray(sol.shifts) &&
    sol.objective !== null &&
    typeof sol.objective === 'object' &&
    Number.isInteger(sol.objective.totalTardiness);
  add('shape', shapeOk, 'solution has status "optimal" and all required sections');
  if (!shapeOk) return { ok: false, checks };

  // --- orders covered exactly once -------------------------------------
  const reported = new Map();
  let covered = true;
  for (const e of sol.orders) {
    if (!e || typeof e !== 'object' || !orderById.has(e.id) || reported.has(e.id)) covered = false;
    else reported.set(e.id, e);
  }
  covered = covered && reported.size === inst.orders.length;
  add('orders-covered', covered, 'every instance order appears exactly once in the solution');
  if (!covered) return { ok: false, checks };

  // --- per-order piece checks ------------------------------------------
  const prodSlots = new Map(); // order id -> sorted slot list
  for (const o of inst.orders) prodSlots.set(o.id, []);
  let piecesOk = true;

  for (const o of inst.orders) {
    const e = reported.get(o.id);
    const pieces = Array.isArray(e.pieces) ? e.pieces : [];
    let total = 0;
    let orderOk = Array.isArray(e.pieces);
    const spans = [];
    for (const p of pieces) {
      const valid =
        p &&
        typeof p === 'object' &&
        machineIndex.has(p.machine) &&
        Number.isInteger(p.start) &&
        Number.isInteger(p.end) &&
        p.start < p.end;
      if (!valid) {
        orderOk = false;
        continue;
      }
      if (!o.machines.includes(p.machine)) orderOk = false;
      total += p.end - p.start;
      spans.push([p.start, p.end]);
      for (let t = p.start; t < p.end; t += 1) {
        if (t < Math.max(o.release, now) || t >= H || shiftOf[t] === -1) orderOk = false;
        prodSlots.get(o.id).push(t);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i][0] < spans[i - 1][1]) orderOk = false; // self overlap
    }
    add(`order:${o.id}:pieces`, orderOk, 'pieces on compatible machines, at/after release, inside shifts, non-overlapping');
    piecesOk = piecesOk && orderOk;
    add(`order:${o.id}:duration`, total === o.duration, `pieces total ${total} slot(s), required ${o.duration}`);
    piecesOk = piecesOk && total === o.duration;
  }

  // --- machine timelines -------------------------------------------------
  const prodAt = inst.machines.map(() => new Map()); // m -> t -> order id
  const changeAt = inst.machines.map(() => new Map()); // m -> t -> entry
  let machinesCovered = true;
  const seenMachines = new Set();
  for (const mach of sol.machines) {
    if (!mach || !machineIndex.has(mach.id) || seenMachines.has(mach.id)) machinesCovered = false;
    else seenMachines.add(mach.id);
  }
  machinesCovered = machinesCovered && seenMachines.size === inst.machines.length;
  add('machines-covered', machinesCovered, 'every instance machine appears exactly once');

  if (machinesCovered) {
    for (const mach of sol.machines) {
      const m = machineIndex.get(mach.id);
      let ok = Array.isArray(mach.timeline);
      let cursor = -1;
      const entries = Array.isArray(mach.timeline) ? mach.timeline : [];
      for (const ent of entries) {
        const valid =
          ent &&
          typeof ent === 'object' &&
          Number.isInteger(ent.start) &&
          Number.isInteger(ent.end) &&
          ent.start < ent.end &&
          ent.start >= cursor &&
          (ent.type === 'production' || ent.type === 'changeover' || ent.type === 'idle');
        if (!valid) {
          ok = false;
          continue;
        }
        cursor = ent.end;
        if (ent.type === 'production') {
          const o = orderById.get(ent.order);
          if (!o || !o.machines.includes(mach.id)) {
            ok = false;
            continue;
          }
          for (let t = ent.start; t < ent.end; t += 1) {
            if (t >= H || shiftOf[t] === -1) ok = false;
            if (prodAt[m].has(t)) ok = false;
            prodAt[m].set(t, ent.order);
          }
        } else if (ent.type === 'changeover') {
          if (ent.end - ent.start !== 1 || !orderById.has(ent.to)) {
            ok = false;
            continue;
          }
          if (ent.start >= H || shiftOf[ent.start] === -1) ok = false;
          if (changeAt[m].has(ent.start) || prodAt[m].has(ent.start)) ok = false;
          changeAt[m].set(ent.start, ent);
        }
      }
      add(`machine:${mach.id}:timeline`, ok, 'entries sorted, non-overlapping, inside shifts, valid references');
      piecesOk = piecesOk && ok;
    }
  } else {
    piecesOk = false;
  }

  // --- no order runs on two machines in the same slot --------------------
  let noDouble = true;
  for (const o of inst.orders) {
    const seenSlots = new Set();
    for (const mMap of prodAt) {
      for (const [t, oid] of mMap) {
        if (oid !== o.id) continue;
        if (seenSlots.has(t)) noDouble = false;
        seenSlots.add(t);
      }
    }
  }
  add('no-simultaneous-machines', noDouble, 'no order is produced on two machines in the same slot');

  // --- preemption structure: every changeover is a justified preemption --
  const preCount = new Map(inst.orders.map((o) => [o.id, 0]));
  let changeoversOk = true;
  let totalChangeovers = 0;
  for (let m = 0; m < inst.machines.length; m += 1) {
    const entries = [...changeAt[m].values()].sort((a, b) => a.start - b.start);
    const prods = [...prodAt[m].entries()].sort((a, b) => a[0] - b[0]);
    for (const c of entries) {
      totalChangeovers += 1;
      let prevOrder = null;
      for (const [t, oid] of prods) {
        if (t < c.start) prevOrder = oid;
        else break;
      }
      const nextOrder = prods.find(([t]) => t === c.end)?.[1] ?? null;
      const prev = prevOrder !== null ? orderById.get(prevOrder) : null;
      const next = nextOrder !== null ? orderById.get(nextOrder) : null;
      const prevDoneBefore = prev
        ? prodSlots.get(prev.id).filter((t) => t < c.start).length
        : 0;
      const valid =
        prev !== null &&
        next !== null &&
        prev.id !== next.id &&
        next.priorityLevel === 3 &&
        prev.priorityLevel < 3 &&
        prevDoneBefore < prev.duration;
      if (!valid) changeoversOk = false;
      else preCount.set(prev.id, preCount.get(prev.id) + 1);
    }
  }
  add('changeovers-justified', changeoversOk, 'every changeover slot is a critical order preempting an incomplete lower-priority order');

  let preOk = true;
  for (const o of inst.orders) {
    const e = reported.get(o.id);
    const n = preCount.get(o.id);
    const ok = Number.isInteger(e.preemptions) && e.preemptions === n && n <= 2;
    add(`order:${o.id}:preemptions`, ok, `reported ${e.preemptions}, recomputed ${n}, limit 2`);
    preOk = preOk && ok;
  }
  add(
    'changeover-count',
    totalChangeovers === [...preCount.values()].reduce((a, b) => a + b, 0),
    `${totalChangeovers} changeover slot(s) match total preemptions`,
  );

  // --- chronological simulation: quota usage and switch legality --------
  const usedSim = inst.shifts.map(() => new Map());
  const couldRun = (oid, t) => {
    const o = orderById.get(oid);
    const sh = t < H ? shiftOf[t] : -1;
    if (sh === -1) return false;
    const used = usedSim[sh].get(o.family) ?? 0;
    const cap = inst.shifts[sh].quotas[o.family] ?? 0;
    return used < cap;
  };
  const loaded = new Array(inst.machines.length).fill(null);
  const doneCount = new Map(inst.orders.map((o) => [o.id, 0]));
  let switchOk = true;
  for (let t = now; t < H; t += 1) {
    for (let m = 0; m < inst.machines.length; m += 1) {
      if (changeAt[m].has(t)) {
        loaded[m] = null;
        continue;
      }
      const oid = prodAt[m].get(t);
      if (oid === undefined) continue;
      const prev = loaded[m];
      if (prev !== null && prev !== oid && doneCount.get(prev) < orderById.get(prev).duration) {
        const ch = changeAt[m].get(t - 1);
        const justified = (ch && ch.to === oid) || !couldRun(prev, t);
        if (!justified) switchOk = false;
      }
      for (let m2 = 0; m2 < inst.machines.length; m2 += 1) {
        if (m2 !== m && loaded[m2] === oid) loaded[m2] = null;
      }
      loaded[m] = oid;
      doneCount.set(oid, doneCount.get(oid) + 1);
      const o = orderById.get(oid);
      const sh = shiftOf[t];
      if (sh !== -1) usedSim[sh].set(o.family, (usedSim[sh].get(o.family) ?? 0) + 1);
      if (doneCount.get(oid) === o.duration) loaded[m] = null;
    }
  }
  add('switch-legality', switchOk, 'an incomplete loaded order is only replaced via preemption, or when it cannot run (shift gap / exhausted quota)');

  // --- shift quota usage --------------------------------------------------
  let quotasOk = true;
  const reportedShifts = new Map();
  for (const s of sol.shifts) if (s && typeof s.id === 'string') reportedShifts.set(s.id, s);
  for (let si = 0; si < inst.shifts.length; si += 1) {
    const def = inst.shifts[si];
    const rep = reportedShifts.get(def.id);
    let ok = rep !== undefined && rep.usage !== null && typeof rep.usage === 'object';
    if (ok) {
      const families = new Set([...Object.keys(def.quotas), ...usedSim[si].keys(), ...Object.keys(rep.usage)]);
      for (const f of families) {
        const used = usedSim[si].get(f) ?? 0;
        const cap = def.quotas[f] ?? 0;
        const reportedUse = rep.usage[f] ?? 0;
        if (used > cap || reportedUse !== used) ok = false;
      }
    }
    add(`shift:${def.id}:quota`, ok, 'recomputed usage matches reported usage and stays within quota');
    quotasOk = quotasOk && ok;
  }

  // --- tardiness and objective -------------------------------------------
  let tardOk = true;
  let total = 0;
  for (const o of inst.orders) {
    const e = reported.get(o.id);
    const slots = prodSlots.get(o.id);
    const completion = slots.length > 0 ? Math.max(...slots) + 1 : 0;
    const tard = Math.max(0, completion - o.deadline);
    total += tard;
    const ok = e.completion === completion && e.tardiness === tard;
    add(`order:${o.id}:tardiness`, ok, `completion ${completion}, tardiness ${tard}`);
    tardOk = tardOk && ok;
  }
  add('objective', sol.objective.totalTardiness === total, `total tardiness recomputed as ${total}`);

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
