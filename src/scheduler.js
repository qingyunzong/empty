import { err, CODES } from './errors.js';
import { buildPrecedenceGraph, checkAcyclic, opId } from './state.js';

// Earliest start >= earliest such that [start, start+duration) fits one window.
export function fitInCalendar(calendar, earliest, duration) {
  for (const [ws, we] of calendar) {
    const start = Math.max(earliest, ws);
    if (start + duration <= we) return start;
  }
  return null;
}

export function getChangeover(state, machine, fromProduct, toProduct) {
  if (fromProduct === toProduct) return 0;
  return state.changeovers[machine]?.[`${fromProduct}>${toProduct}`] ?? 0;
}

// Simulate a complete op sequence (array of "order:index" ids, precedence-valid).
// Returns { objective, changeover, sequence, assignments } or null if infeasible.
export function simulate(state, opOrder) {
  const machineFree = new Map();
  const machineProduct = new Map();
  const machineSeq = new Map();
  const endOf = new Map();
  const completion = new Map();
  const assignments = {};
  let changeover = 0;

  const preds = buildPrecedenceGraph(state);

  for (const id of opOrder) {
    const [orderId, idxStr] = id.split(':');
    const idx = Number(idxStr);
    const order = state.orders[orderId];
    const op = order.ops[idx];
    let earliest = 0;
    for (const p of preds.get(id) ?? []) earliest = Math.max(earliest, endOf.get(p) ?? 0);
    const machine = op.machine;
    const prevProduct = machineProduct.get(machine);
    const co = prevProduct === undefined ? 0 : getChangeover(state, machine, prevProduct, order.product);
    earliest = Math.max(earliest, (machineFree.get(machine) ?? 0) + co);
    const start = fitInCalendar(state.machines[machine].calendar, earliest, op.duration);
    if (start === null) return null;
    const end = start + op.duration;
    endOf.set(id, end);
    machineFree.set(machine, end);
    machineProduct.set(machine, order.product);
    if (!machineSeq.has(machine)) machineSeq.set(machine, []);
    machineSeq.get(machine).push(orderId);
    completion.set(orderId, Math.max(completion.get(orderId) ?? 0, end));
    assignments[id] = { machine, start, end };
    changeover += co;
  }

  let objective = 0;
  for (const [id, order] of Object.entries(state.orders)) {
    objective += order.priority * completion.get(id);
  }
  const sequence = [...machineSeq.keys()].sort().flatMap((m) => machineSeq.get(m));
  return { objective, changeover, sequence, assignments };
}

export function compareSolutions(a, b) {
  if (a.objective !== b.objective) return a.objective - b.objective;
  if (a.changeover !== b.changeover) return a.changeover - b.changeover;
  const n = Math.min(a.sequence.length, b.sequence.length);
  for (let i = 0; i < n; i++) {
    if (a.sequence[i] !== b.sequence[i]) return a.sequence[i] < b.sequence[i] ? -1 : 1;
  }
  return a.sequence.length - b.sequence.length;
}

// Exact solver: branch and bound over topological orders of the precedence DAG.
export function solveSchedule(state) {
  const topo = checkAcyclic(state); // throws E_PRECEDENCE on cycles
  void topo;

  const preds = buildPrecedenceGraph(state);
  const allOps = [];
  for (const order of Object.values(state.orders)) {
    order.ops.forEach((_, i) => allOps.push(opId(order.id, i)));
  }
  allOps.sort();
  const remaining = new Map(allOps.map((id) => [id, preds.get(id)?.size ?? 0]));
  const succ = new Map();
  for (const [id, ps] of preds) {
    for (const p of ps) {
      if (!succ.has(p)) succ.set(p, []);
      succ.get(p).push(id);
    }
  }

  let best = null;
  const chosen = [];

  // Incremental simulation state for bound + final eval simplicity: we just
  // re-simulate complete sequences (problem sizes are small by design).
  function dfs() {
    if (chosen.length === allOps.length) {
      const sol = simulate(state, chosen);
      if (sol && (best === null || compareSolutions(sol, best) < 0)) best = sol;
      return;
    }
    const avail = allOps.filter((id) => !chosen.includes(id) && remaining.get(id) === 0).sort();
    for (const id of avail) {
      chosen.push(id);
      for (const nxt of succ.get(id) ?? []) remaining.set(nxt, remaining.get(nxt) - 1);
      remaining.set(id, -1);
      dfs();
      remaining.set(id, 0);
      // restore: recompute indegree contribution
      for (const nxt of succ.get(id) ?? []) remaining.set(nxt, remaining.get(nxt) + 1);
      chosen.pop();
    }
  }
  dfs();

  if (best === null) {
    throw err(CODES.E_STATE, 'no feasible schedule within machine calendars');
  }
  if (state.budget !== null && best.objective > state.budget) {
    throw err(CODES.E_BUDGET, `best objective ${best.objective} exceeds budget ${state.budget}`);
  }
  return best;
}
