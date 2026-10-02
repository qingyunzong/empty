import { applyChange, validatePlan, penalty, PlanError } from './plan.js';
import { leq, concurrent } from './clock.js';

export function topoSortChanges(changes) {
  const byId = new Map(changes.map((c) => [c.changeId, c]));
  const indeg = new Map(changes.map((c) => [c.changeId, 0]));
  const edges = new Map(changes.map((c) => [c.changeId, []]));
  for (const a of changes) {
    for (const b of changes) {
      if (a !== b && leq(a.clock, b.clock)) {
        edges.get(a.changeId).push(b.changeId);
        indeg.set(b.changeId, indeg.get(b.changeId) + 1);
      }
    }
  }
  const ready = changes.filter((c) => indeg.get(c.changeId) === 0).map((c) => c.changeId).sort();
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(byId.get(id));
    for (const nxt of edges.get(id)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) {
        ready.push(nxt);
        ready.sort();
      }
    }
  }
  if (out.length !== changes.length) throw new Error('inconsistent vector clocks (cycle)');
  return out;
}

function clustersOf(list) {
  const parent = new Map(list.map((c) => [c.changeId, c.changeId]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (concurrent(list[i].clock, list[j].clock)) {
        parent.set(find(list[i].changeId), find(list[j].changeId));
      }
    }
  }
  const groups = new Map();
  for (const c of list) {
    const r = find(c.changeId);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  return [...groups.values()];
}

export function materialize(base, changes, constraints = {}) {
  const order = topoSortChanges(changes);
  const byOp = new Map();
  for (const c of order) {
    const t = c.op && c.op.id;
    if (!byOp.has(t)) byOp.set(t, []);
    byOp.get(t).push(c);
  }
  const inCluster = new Set();
  const clusters = [];
  for (const [opId, list] of byOp) {
    for (const cl of clustersOf(list)) {
      if (cl.length > 1) {
        clusters.push({ opId, members: cl });
        for (const c of cl) inCluster.add(c.changeId);
      }
    }
  }
  let evalPlan = structuredClone(base);
  for (const c of order) {
    if (inCluster.has(c.changeId)) continue;
    try { evalPlan = applyChange(evalPlan, c); } catch { /* best effort */ }
  }
  const losers = new Map();
  const conflicts = [];
  for (const { opId, members } of clusters) {
    const cancels = members.filter((c) => c.type === 'cancel');
    let winners;
    let rule;
    let costs;
    if (cancels.length > 0) {
      winners = cancels.map((c) => c.changeId).sort();
      rule = 'cancel-wins';
    } else {
      const inserts = members.filter((c) => c.type === 'insert');
      if (inserts.length > 1) {
        winners = [inserts.map((c) => c.changeId).sort()[0]];
        rule = 'insert-first';
      } else {
        costs = {};
        for (const c of members) {
          try { costs[c.changeId] = penalty(applyChange(evalPlan, c)); }
          catch { costs[c.changeId] = null; }
        }
        const rank = (c) => [costs[c.changeId] === null ? Infinity : costs[c.changeId], c.changeId];
        const sorted = [...members].sort((a, b) => {
          const ra = rank(a); const rb = rank(b);
          return ra[0] - rb[0] || (ra[1] < rb[1] ? -1 : ra[1] > rb[1] ? 1 : 0);
        });
        winners = [sorted[0].changeId];
        rule = 'min-cost-then-changeId';
      }
    }
    const winSet = new Set(winners);
    for (const c of members) {
      if (!winSet.has(c.changeId)) {
        losers.set(c.changeId, { changeId: c.changeId, op: opId, reason: 'conflict-' + c.type });
      }
    }
    const record = { op: opId, contenders: members.map((c) => c.changeId).sort(), winners, rule };
    if (costs) record.costs = costs;
    conflicts.push(record);
  }
  let plan = structuredClone(base);
  const pending = [];
  for (const c of order) {
    if (losers.has(c.changeId)) { pending.push(losers.get(c.changeId)); continue; }
    let next;
    try {
      next = applyChange(plan, c);
    } catch (e) {
      if (e instanceof PlanError) {
        pending.push({ changeId: c.changeId, op: c.op && c.op.id, reason: 'invalid', violations: e.violations });
        continue;
      }
      throw e;
    }
    const v = validatePlan(next, constraints);
    if (v.length) {
      pending.push({ changeId: c.changeId, op: c.op && c.op.id, reason: 'invalid', violations: v });
    } else {
      plan = next;
    }
  }
  return { plan, pending, conflicts, order };
}
