// Exact branch-and-bound solver over discrete time slots.
//
// Model (see README.md):
//  - Time is slotted 0..H-1, H = end of the last shift. Production of family f
//    at slot t requires a shift covering t with remaining quota for f.
//  - Each order runs entirely on one compatible machine, possibly in several
//    segments. A machine "holds" the mould of its last unfinished order.
//  - A critical order may preempt a lower-priority (non-critical) order that
//    is loaded on a machine. Each preemption inserts exactly one changeover
//    slot on that machine, immediately before the critical order's segment.
//    An order may be preempted at most twice. Critical orders are never
//    preempted (only lower-priority orders may be preempted).
//  - Objective: minimize total tardiness sum_i max(0, C_i - deadline_i).
//    Ties are broken by the lexicographically smallest vector of completion
//    times with orders sorted by id ("按工单编号字典序").

import { verifySolution } from './verify.js';

export function solve(instance) {
  const reasons = precheck(instance);
  if (reasons.length > 0) return { status: 'infeasible', reasons };
  const best = search(instance);
  if (!best) {
    return {
      status: 'infeasible',
      reasons: ['no feasible schedule: machine/shift capacity cannot complete all orders'],
    };
  }
  const solution = buildSolution(instance, best);
  const certificate = verifySolution(instance, solution);
  if (!certificate.ok) {
    throw new Error('internal error: solver produced a schedule that fails verification');
  }
  solution.certificate = certificate;
  return solution;
}

// Necessary-condition pre-checks. They exist to produce precise reasons;
// the exact search below remains the completeness oracle.
function precheck(inst) {
  const reasons = [];
  for (const o of inst.orders) {
    if (o.machines.length === 0) reasons.push(`order ${o.id}: no compatible machine`);
  }
  const demand = new Map();
  for (const o of inst.orders) demand.set(o.family, (demand.get(o.family) ?? 0) + o.duration);
  const capacity = new Map();
  for (const s of inst.shifts) {
    for (const [f, q] of Object.entries(s.quotas)) capacity.set(f, (capacity.get(f) ?? 0) + q);
  }
  for (const [family, d] of demand) {
    const c = capacity.get(family) ?? 0;
    if (d > c) reasons.push(`family ${family}: demand ${d} slot(s) exceeds total quota ${c}`);
  }
  for (const o of inst.orders) {
    if (o.release >= inst.horizon) {
      reasons.push(
        `order ${o.id}: release ${o.release} is at/after the end of the last shift (${inst.horizon}); ` +
        'no capacity exists after its release (a future release alone is not infeasibility, but this one can never be served)');
      continue;
    }
    let quotaAfterRelease = 0;
    for (const s of inst.shifts) {
      if (s.end > o.release) quotaAfterRelease += s.quotas[o.family] ?? 0;
    }
    if (quotaAfterRelease < o.duration) {
      reasons.push(
        `order ${o.id}: only ${quotaAfterRelease} quota slot(s) of family ${o.family} ` +
        `available at/after release ${o.release}, but duration is ${o.duration}`);
    }
  }
  return reasons;
}

function search(inst) {
  const M = inst.machines.length;
  const N = inst.orders.length;
  const H = inst.horizon;
  if (N === 0) return { tardiness: 0, completion: [], log: [] };

  const shiftOfSlot = new Int32Array(Math.max(H, 1)).fill(-1);
  inst.shifts.forEach((s, si) => { for (let t = s.start; t < s.end; t++) shiftOfSlot[t] = si; });
  const famIndex = new Map(inst.families.map((f, i) => [f, i]));
  const famOf = inst.orders.map((o) => famIndex.get(o.family));
  const quotaRem = inst.shifts.map((s) => inst.families.map((f) => s.quotas[f] ?? 0));

  const remaining = inst.orders.map((o) => o.duration);
  const preempts = new Array(N).fill(0);
  const loaded = new Array(M).fill(-1);     // order whose mould is on the machine (-1 = empty)
  const must = new Array(M).fill(-1);       // committed changeover: must produce this order next slot
  const completion = new Array(N).fill(-1);
  const compatSet = inst.orders.map((o) => new Set(o.machines));
  const assigned = new Array(N).fill(-1); // an order runs entirely on one machine
  const NO_NOW = new Set();               // empty "producing this slot" set
  const critical = inst.orders.map((o) => o.critical);
  const deadline = inst.orders.map((o) => o.deadline);
  const release = inst.orders.map((o) => o.release);

  const urgency = [...Array(N).keys()].sort((a, b) =>
    (critical[b] - critical[a]) || (deadline[a] - deadline[b]) ||
    (inst.orders[a].id < inst.orders[b].id ? -1 : 1));
  const criticalsByMachine = Array.from({ length: M }, (_, m) =>
    urgency.filter((i) => critical[i] && compatSet[i].has(m)));
  const idOrder = [...Array(N).keys()].sort((a, b) =>
    inst.orders[a].id < inst.orders[b].id ? -1 : 1);

  const events = [...new Set([...release, ...inst.shifts.map((s) => s.start)])]
    .filter((x) => x > 0).sort((a, b) => a - b);

  let tardiness = 0;
  let done = 0;
  const log = [];
  let best = null;

  const lexLess = (a, b) => {
    for (const i of idOrder) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };

  function lowerBound(t) {
    let bound = tardiness;
    for (let i = 0; i < N; i++) {
      if (remaining[i] > 0) {
        const c = t + remaining[i];
        if (c > deadline[i]) bound += c - deadline[i];
      }
    }
    return bound;
  }

  // With equal tardiness, can this branch still beat the incumbent on the
  // lexicographic completion-time tie-break?
  function tiebreakHope(t) {
    for (const i of idOrder) {
      const lb = remaining[i] === 0 ? completion[i] : t + remaining[i];
      if (lb !== best.completion[i]) return lb < best.completion[i];
    }
    return false;
  }

  function enoughSlots(i, t) {
    const f = famOf[i];
    let need = remaining[i];
    for (let s = Math.max(t, release[i]); s < H && need > 0; s++) {
      const sh = shiftOfSlot[s];
      if (sh >= 0 && quotaRem[sh][f] > 0) need--;
    }
    return need === 0;
  }

  function canProduce(x, m, t, now = NO_NOW) {
    if (t >= H || release[x] > t || remaining[x] === 0 || !compatSet[x].has(m)) return false;
    if (assigned[x] !== -1 && assigned[x] !== m) return false;
    if (now.has(x)) return false; // an order cannot run on two machines in one slot
    const sh = shiftOfSlot[t];
    return sh >= 0 && quotaRem[sh][famOf[x]] > 0;
  }

  // kind: 0 = produce, 1 = changeover (preempt), 2 = idle
  const lists = Array.from({ length: M }, () => []);
  function actionsFor(m, t) {
    const out = lists[m];
    out.length = 0;
    if (must[m] >= 0) {
      out.push({ kind: 0, order: must[m] });
      return out;
    }
    const b = loaded[m];
    if (b >= 0) {
      if (canProduce(b, m, t)) out.push({ kind: 0, order: b });
      if (!critical[b] && preempts[b] < 2) {
        for (const c of criticalsByMachine[m]) {
          if (remaining[c] > 0 && canProduce(c, m, t + 1)) out.push({ kind: 1, order: c });
        }
      }
      // Idle is always allowed: another machine may need the shared quota
      // this slot, so suppressing it would be unsound.
      out.push({ kind: 2, order: -1 });
      return out;
    }
    for (const x of urgency) {
      if (remaining[x] > 0 && canProduce(x, m, t)) out.push({ kind: 0, order: x });
    }
    out.push({ kind: 2, order: -1 });
    return out;
  }

  function apply(m, a, t, now) {
    if (a.kind === 2) return true;
    if (a.kind === 1) {
      const b = loaded[m];
      const c = a.order;
      if (b < 0 || critical[b] || preempts[b] >= 2) return false;
      a._b = b;
      preempts[b]++;
      loaded[m] = c;
      must[m] = c;
      log.push({ t, m, kind: 'changeover', preempted: b, by: c });
      return true;
    }
    const x = a.order;
    if (!canProduce(x, m, t, now)) return false;
    if (must[m] >= 0 && must[m] !== x) return false;
    if (loaded[m] >= 0 && loaded[m] !== x) return false;
    a._prevLoaded = loaded[m];
    a._prevMust = must[m];
    a._assigned = assigned[x] === -1;
    if (a._assigned) assigned[x] = m;
    now.add(x);
    quotaRem[shiftOfSlot[t]][famOf[x]]--;
    remaining[x]--;
    must[m] = -1;
    log.push({ t, m, kind: 'produce', order: x });
    if (remaining[x] === 0) {
      completion[x] = t + 1;
      const late = t + 1 - deadline[x];
      if (late > 0) tardiness += late;
      done++;
      loaded[m] = -1;
    } else {
      loaded[m] = x;
    }
    return true;
  }

  function undo(m, a, t, now) {
    if (a.kind === 2) return;
    if (a.kind === 1) {
      const b = a._b;
      must[m] = -1;
      loaded[m] = b;
      preempts[b]--;
      log.pop();
      return;
    }
    const x = a.order;
    log.pop();
    if (remaining[x] === 0) {
      done--;
      const late = t + 1 - deadline[x];
      if (late > 0) tardiness -= late;
      completion[x] = -1;
    }
    remaining[x]++;
    quotaRem[shiftOfSlot[t]][famOf[x]]++;
    now.delete(x);
    if (a._assigned) assigned[x] = -1;
    loaded[m] = a._prevLoaded;
    must[m] = a._prevMust;
  }

  function combo(m, t, now, allActions) {
    if (m === M) { dfs(t + 1); return; }
    for (const a of allActions[m]) {
      if (apply(m, a, t, now)) {
        combo(m + 1, t, now, allActions);
        undo(m, a, t, now);
      }
    }
  }

  function dfs(t) {
    if (done === N) {
      if (!best || tardiness < best.tardiness ||
          (tardiness === best.tardiness && lexLess(completion, best.completion))) {
        best = { tardiness, completion: completion.slice(), log: log.slice() };
      }
      return;
    }
    if (t >= H) return;
    if (best) {
      const lb = lowerBound(t);
      if (lb > best.tardiness) return;
      if (lb === best.tardiness && !tiebreakHope(t)) return;
    }
    let sumRemaining = 0;
    for (let i = 0; i < N; i++) {
      if (remaining[i] > 0) {
        sumRemaining += remaining[i];
        if (!enoughSlots(i, t)) return;
      }
    }
    if (sumRemaining > (H - t) * M) return;
    let allIdle = true;
    // Snapshot every machine's action list now: deeper recursion refills
    // the shared `lists` arrays, and combo() is re-entered per parent action.
    const allActions = [];
    for (let m = 0; m < M; m++) {
      actionsFor(m, t);
      allActions.push(lists[m].slice());
      if (!(lists[m].length === 1 && lists[m][0].kind === 2)) allIdle = false;
    }
    if (allIdle) {
      let next = Infinity;
      for (const e of events) if (e > t) { next = e; break; }
      if (next === Infinity) return;
      dfs(Math.min(next, H));
      return;
    }
    combo(0, t, new Set(), allActions);
  }

  dfs(0);
  return best;
}

function buildSolution(inst, best) {
  const M = inst.machines.length;
  const shiftOfSlot = new Int32Array(Math.max(inst.horizon, 1)).fill(-1);
  inst.shifts.forEach((s, si) => { for (let t = s.start; t < s.end; t++) shiftOfSlot[t] = si; });

  const slices = Array.from({ length: M }, () => []);
  const log = [...best.log].sort((a, b) => (a.t - b.t) || (a.m - b.m));
  const preemptionEvents = [];
  for (const e of log) {
    if (e.kind === 'produce') {
      const arr = slices[e.m];
      const id = inst.orders[e.order].id;
      const last = arr[arr.length - 1];
      if (last && last.type === 'production' && last.order === id && last.end === e.t) {
        last.end = e.t + 1;
      } else {
        arr.push({ start: e.t, end: e.t + 1, type: 'production', order: id });
      }
    } else {
      slices[e.m].push({
        start: e.t,
        end: e.t + 1,
        type: 'changeover',
        preempted: inst.orders[e.preempted].id,
        by: inst.orders[e.by].id,
      });
      preemptionEvents.push({
        slot: e.t,
        machine: inst.machines[e.m].id,
        preempted: inst.orders[e.preempted].id,
        by: inst.orders[e.by].id,
      });
    }
  }

  const preemptCount = new Map();
  for (const ev of preemptionEvents) {
    preemptCount.set(ev.preempted, (preemptCount.get(ev.preempted) ?? 0) + 1);
  }

  const orders = inst.orders.map((o, i) => {
    const machineIdx = slices.findIndex((arr) => arr.some((s) => s.order === o.id));
    const segments = machineIdx >= 0
      ? slices[machineIdx].filter((s) => s.order === o.id).map((s) => ({ start: s.start, end: s.end }))
      : [];
    const completionTime = best.completion[i];
    return {
      id: o.id,
      machine: machineIdx >= 0 ? inst.machines[machineIdx].id : null,
      segments,
      completion: completionTime,
      deadline: o.deadline,
      tardiness: Math.max(0, completionTime - o.deadline),
      preemptions: preemptCount.get(o.id) ?? 0,
    };
  });

  const usage = inst.shifts.map(() => new Map());
  for (const e of log) {
    if (e.kind !== 'produce') continue;
    const sh = shiftOfSlot[e.t];
    const fam = inst.orders[e.order].family;
    usage[sh].set(fam, (usage[sh].get(fam) ?? 0) + 1);
  }
  const quotaUsage = [];
  inst.shifts.forEach((s, si) => {
    const fams = new Set([...Object.keys(s.quotas), ...usage[si].keys()]);
    for (const family of [...fams].sort()) {
      quotaUsage.push({
        shift: s.id,
        family,
        used: usage[si].get(family) ?? 0,
        capacity: s.quotas[family] ?? 0,
      });
    }
  });

  return {
    status: 'optimal',
    objective: { totalTardiness: best.tardiness },
    orders,
    machines: inst.machines.map((m, i) => ({ id: m.id, slices: slices[i] })),
    quotaUsage,
    preemptions: {
      total: preemptionEvents.length,
      byOrder: Object.fromEntries([...preemptCount.entries()].sort()),
      events: preemptionEvents,
    },
  };
}
