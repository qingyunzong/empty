// Exact branch-and-bound solver over discrete time slots.
//
// Model (see README.md):
//  - Time is slotted; production/changeover only inside shift windows.
//  - Each shift caps the number of production slots per product family
//    (across all machines). A family missing from a shift's quotas has 0.
//  - A machine is "loaded" with the last order it ran while that order is
//    incomplete. Switching a loaded, runnable order to another order is a
//    preemption: only a critical order may preempt a lower-priority one,
//    it costs 1 changeover slot immediately before the preempting piece,
//    and each order may be preempted at most 2 times. If the loaded order
//    cannot run at a slot (no shift covers it or its family quota is
//    exhausted), the machine may idle or switch freely (no preemption).
//  - Objective: minimize total tardiness; ties broken by the lexicographic
//    vector of per-order tardiness with orders sorted by id.

import { verifySolution } from './verify.js';

const NODE_LIMIT = 20_000_000;

export function solve(inst) {
  const reasons = [];
  const orders = inst.orders;
  const N = orders.length;

  for (const o of orders) {
    if (o.deadline < o.release) {
      reasons.push(
        `order ${o.id}: deadline ${o.deadline} is earlier than release ${o.release}; it can never finish on time`,
      );
    }
  }
  const need = new Map();
  for (const o of orders) need.set(o.family, (need.get(o.family) ?? 0) + o.duration);
  const capacity = new Map();
  for (const s of inst.shifts) {
    for (const [f, q] of Object.entries(s.quotas)) capacity.set(f, (capacity.get(f) ?? 0) + q);
  }
  for (const [f, n] of need) {
    const c = capacity.get(f) ?? 0;
    if (c < n) {
      reasons.push(`family ${f}: total shift quota ${c} slot(s) is below required ${n} slot(s)`);
    }
  }
  if (reasons.length > 0) return { status: 'infeasible', reasons };

  const M = inst.machines.length;
  const now = inst.now;
  const families = [...new Set(orders.map((o) => o.family))].sort();
  const F = families.length;
  const famIndex = new Map(families.map((f, i) => [f, i]));

  const rel = orders.map((o) => o.release);
  const dur = orders.map((o) => o.duration);
  const dead = orders.map((o) => o.deadline);
  const fam = orders.map((o) => famIndex.get(o.family));
  const prio = orders.map((o) => o.priorityLevel);
  const machineIndex = new Map(inst.machines.map((id, i) => [id, i]));
  const compat = orders.map((o) => o.machines.reduce((mask, id) => mask | (1 << machineIndex.get(id)), 0));

  const S = inst.shifts.length;
  const H = S > 0 ? Math.max(...inst.shifts.map((s) => s.end)) : 0;
  const shiftOf = new Int32Array(Math.max(H, 1)).fill(-1);
  inst.shifts.forEach((s, si) => {
    for (let t = Math.max(s.start, now); t < s.end; t += 1) shiftOf[t] = si;
  });
  const quota = inst.shifts.map((s) => families.map((f) => s.quotas[f] ?? 0));

  const edd = [...Array(N).keys()].sort((a, b) => dead[a] - dead[b] || a - b);

  const events = []; // shared path log, pushed/popped during search
  const memo = new Map();
  let best = null;
  let nodes = 0;

  const canRun = (st, x, t) => {
    const sh = shiftOf[t];
    return sh !== -1 && st.used[sh * F + fam[x]] < quota[sh][fam[x]];
  };

  const lexLess = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  const lexLeq = (a, b) => a === b || !lexLess(b, a);

  function leaf(st) {
    let total = 0;
    const vec = new Array(N);
    for (let i = 0; i < N; i += 1) {
      vec[i] = Math.max(0, st.comp[i] - dead[i]);
      total += vec[i];
    }
    if (best === null || total < best.total || (total === best.total && lexLess(vec, best.vec))) {
      best = {
        total,
        vec,
        events: events.slice(),
        comp: st.comp.slice(),
        pre: st.pre.slice(),
        used: st.used.slice(),
      };
    }
  }

  function recurse(st, t, m) {
    nodes += 1;
    if (nodes > NODE_LIMIT) throw new Error('search node limit exceeded');
    if (t >= H) {
      for (let i = 0; i < N; i += 1) if (st.done[i] < dur[i]) return;
      leaf(st);
      return;
    }

    // Necessary-condition prune: remaining family quota must cover remaining work.
    for (let f = 0; f < F; f += 1) {
      let remWork = 0;
      for (let i = 0; i < N; i += 1) if (fam[i] === f) remWork += dur[i] - st.done[i];
      if (remWork === 0) continue;
      let remCap = 0;
      for (let s = 0; s < S; s += 1) remCap += quota[s][f] - st.used[s * F + f];
      if (remWork > remCap) return;
    }

    // Tardiness lower bound for branch and bound.
    let cost = 0;
    let bound = 0;
    const costVec = new Array(N).fill(-1);
    for (let i = 0; i < N; i += 1) {
      if (st.comp[i] >= 0) {
        const tard = Math.max(0, st.comp[i] - dead[i]);
        cost += tard;
        costVec[i] = tard;
      } else {
        const est = Math.max(t, rel[i]) + (dur[i] - st.done[i]);
        bound += Math.max(0, est - dead[i]);
      }
    }
    bound += cost;
    if (best !== null && bound > best.total) return;

    // Dominance memo: identical state reached with no better (cost, vector) is pruned.
    const key = [
      t, m, st.usedSlot,
      ...st.cur, ...st.pending, ...st.done, ...st.pre, ...st.used,
    ].join(',');
    const seen = memo.get(key);
    if (seen && (seen.cost < cost || (seen.cost === cost && lexLeq(seen.vec, costVec)))) return;
    if (!seen || cost < seen.cost || (cost === seen.cost && lexLess(costVec, seen.vec))) {
      memo.set(key, { cost, vec: costVec });
    }

    const nextM = m + 1 < M ? m + 1 : 0;
    const nextT = m + 1 < M ? t : t + 1;

    const eligible = (x, at) =>
      st.done[x] < dur[x] &&
      rel[x] <= at &&
      (compat[x] & (1 << m)) !== 0 &&
      (st.usedSlot & (1 << x)) === 0 &&
      !st.pending.includes(x);

    const actions = [];
    const pm = st.pending[m];
    if (pm !== -1) {
      // Forced: the changeover finished, the preempting order must start now.
      if (!canRun(st, pm, t)) return;
      actions.push({ kind: 'produce', order: pm, clearPending: true });
    } else {
      const y = st.cur[m];
      const yActive = y !== -1 && st.done[y] < dur[y];
      const yCan = yActive && canRun(st, y, t);
      if (yActive && yCan) {
        actions.push({ kind: 'produce', order: y });
        if (st.pre[y] < 2 && prio[y] < 3 && shiftOf[t] >= 0 && t + 1 < H) {
          for (const x of edd) {
            if (x === y || prio[x] !== 3) continue;
            if (!eligible(x, t + 1)) continue;
            if (st.cur.some((c, mm) => mm !== m && c === x)) continue;
            if (!canRun(st, x, t + 1)) continue;
            actions.push({ kind: 'preempt', order: x, preempted: y });
          }
        }
        actions.push({ kind: 'idle' });
      } else {
        // Machine free, or loaded order cannot run now (shift gap / quota).
        actions.push({ kind: 'idle' });
        for (const x of edd) {
          if (x === y) continue;
          if (!eligible(x, t)) continue;
          if (!canRun(st, x, t)) continue;
          actions.push({ kind: 'start', order: x });
        }
      }
    }

    for (const a of actions) {
      const s2 = apply(st, a, t, m);
      if (nextM === 0) s2.usedSlot = 0;
      recurse(s2, nextT, nextM);
      if (a.kind !== 'idle') events.pop();
    }
  }

  function apply(st, a, t, m) {
    const s2 = {
      cur: st.cur.slice(),
      pending: st.pending.slice(),
      done: st.done.slice(),
      pre: st.pre.slice(),
      comp: st.comp.slice(),
      used: st.used.slice(),
      usedSlot: st.usedSlot,
    };
    if (a.kind === 'preempt') {
      s2.pre[a.preempted] += 1;
      s2.cur[m] = -1;
      s2.pending[m] = a.order;
      events.push({ t, m, kind: 'changeover', to: a.order, preempted: a.preempted });
      return s2;
    }
    if (a.kind === 'produce' || a.kind === 'start') {
      const x = a.order;
      if (a.clearPending) s2.pending[m] = -1;
      for (let m2 = 0; m2 < M; m2 += 1) if (m2 !== m && s2.cur[m2] === x) s2.cur[m2] = -1;
      s2.cur[m] = x;
      s2.usedSlot |= 1 << x;
      const sh = shiftOf[t];
      s2.used[sh * F + fam[x]] += 1;
      s2.done[x] += 1;
      events.push({ t, m, kind: 'production', order: x });
      if (s2.done[x] === dur[x]) {
        s2.comp[x] = t + 1;
        s2.cur[m] = -1;
      }
      return s2;
    }
    return s2; // idle
  }

  const initial = {
    cur: new Array(M).fill(-1),
    pending: new Array(M).fill(-1),
    done: new Array(N).fill(0),
    pre: new Array(N).fill(0),
    comp: new Array(N).fill(-1),
    used: new Array(S * F).fill(0),
    usedSlot: 0,
  };
  recurse(initial, now, 0);

  if (best === null) {
    return {
      status: 'infeasible',
      reasons: [
        'no feasible schedule exists within the planning horizon ' +
          '(exhaustive search over machine assignments, order sequences and preemption points)',
      ],
    };
  }

  const solution = buildSolution(inst, best, families);
  solution.certificate = verifySolution(inst, solution);
  return solution;
}

function buildSolution(inst, best, families) {
  const F = families.length;
  const orderIds = inst.orders.map((o) => o.id);

  const perMachine = inst.machines.map(() => []);
  for (const e of best.events) perMachine[e.m].push(e);

  const machinesOut = inst.machines.map((id, m) => {
    const merged = [];
    for (const e of perMachine[m]) {
      if (e.kind === 'production') {
        const last = merged[merged.length - 1];
        if (last && last.type === 'production' && last.order === orderIds[e.order] && last.end === e.t) {
          last.end += 1;
        } else {
          merged.push({ type: 'production', order: orderIds[e.order], start: e.t, end: e.t + 1 });
        }
      } else {
        merged.push({
          type: 'changeover',
          to: orderIds[e.to],
          preempted: orderIds[e.preempted],
          start: e.t,
          end: e.t + 1,
        });
      }
    }
    const timeline = [];
    let cursor = inst.now;
    for (const ent of merged) {
      if (ent.start > cursor) timeline.push({ type: 'idle', start: cursor, end: ent.start });
      timeline.push(ent);
      cursor = ent.end;
    }
    return { id, timeline };
  });

  const ordersOut = inst.orders.map((o, i) => {
    const pieces = [];
    for (const mach of machinesOut) {
      for (const ent of mach.timeline) {
        if (ent.type === 'production' && ent.order === o.id) {
          pieces.push({ machine: mach.id, start: ent.start, end: ent.end });
        }
      }
    }
    pieces.sort((a, b) => a.start - b.start);
    return {
      id: o.id,
      pieces,
      preemptions: best.pre[i],
      completion: best.comp[i],
      tardiness: best.vec[i],
    };
  });

  const shiftsOut = inst.shifts.map((s, si) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    quotas: s.quotas,
    usage: Object.fromEntries(families.map((f, fi) => [f, best.used[si * F + fi]])),
  }));

  const totalPreemptions = best.pre.reduce((a, b) => a + b, 0);
  return {
    status: 'optimal',
    objective: { totalTardiness: best.total },
    preemptions: { total: totalPreemptions },
    orders: ordersOut,
    machines: machinesOut,
    shifts: shiftsOut,
  };
}
