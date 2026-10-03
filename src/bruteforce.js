import { canon } from './canon.js';
import { validateInstance, indexInstance } from './instance.js';
import { buildSchedule } from './schedule.js';
import { invalidInput } from './errors.js';

// Exhaustive reference solver: enumerates topological orders x parameter
// assignments x machine assignments. Used to cross-check the solver.
export function bruteForce(rawInst, pins = {}) {
  const inst = validateInstance(rawInst);
  const idx = indexInstance(inst);
  for (const [step, value] of Object.entries(pins)) {
    const s = idx.byId.get(step);
    if (!s) throw invalidInput(`pin references unknown step ${JSON.stringify(step)}`);
    if (!s.params.includes(value)) {
      throw invalidInput(`pin value ${JSON.stringify(value)} not in domain of step ${JSON.stringify(step)}`);
    }
  }
  for (const s of inst.steps) {
    if (s.memory > inst.memoryLimit) return { status: 'UNSAT', plan: null };
  }
  const domains = new Map(
    inst.steps.map((s) => [s.id, pins[s.id] !== undefined ? [pins[s.id]] : [...s.params].sort()]),
  );
  for (const [id, dom] of domains) {
    if (dom.length === 0) return { status: 'UNSAT', plan: null };
  }

  const ids = idx.topo;
  const n = ids.length;

  // All topological orders via backtracking over ready sets.
  const orders = [];
  {
    const indeg = new Map(ids.map((id) => [id, idx.preds.get(id).length]));
    const current = [];
    const visit = () => {
      if (current.length === n) {
        orders.push([...current]);
        return;
      }
      for (const id of ids) {
        if (indeg.get(id) !== 0) continue;
        indeg.set(id, -1);
        current.push(id);
        for (const v of idx.succs.get(id)) indeg.set(v, indeg.get(v) - 1);
        visit();
        for (const v of idx.succs.get(id)) indeg.set(v, indeg.get(v) + 1);
        current.pop();
        indeg.set(id, 0);
        // restore: recompute is unnecessary; indeg back to 0 means ready again
      }
    };
    visit();
  }

  const paramLists = ids.map((id) => domains.get(id));
  const machineLists = ids.map(() => Array.from({ length: inst.machines }, (_, i) => i));

  let best = null;
  const paramChoice = new Array(n);
  const machineChoice = new Array(n);

  function compatOk() {
    for (const c of inst.compat) {
      const ia = ids.indexOf(c.between[0]);
      const ib = ids.indexOf(c.between[1]);
      const pair = [paramChoice[ia], paramChoice[ib]];
      if (!c.allow.some(([x, y]) => x === pair[0] && y === pair[1])) return false;
    }
    return true;
  }

  function* product(lists, i = 0, acc = []) {
    if (i === lists.length) {
      yield acc;
      return;
    }
    for (const v of lists[i]) yield* product(lists, i + 1, [...acc, v]);
  }

  for (const order of orders) {
    for (const params of product(paramLists)) {
      for (let i = 0; i < n; i++) paramChoice[i] = params[i];
      if (!compatOk()) continue;
      for (const machines of product(machineLists)) {
        for (let i = 0; i < n; i++) machineChoice[i] = machines[i];
        const pos = new Map(ids.map((id, i) => [id, i]));
        const decisions = order.map((id) => ({
          step: id,
          param: paramChoice[pos.get(id)],
          machine: machineChoice[pos.get(id)],
        }));
        const { jobs, makespan, peak } = buildSchedule(inst, decisions, idx);
        const candidate = { jobs, makespan, peak, key: canon(jobs) };
        if (
          !best ||
          candidate.makespan < best.makespan ||
          (candidate.makespan === best.makespan && candidate.key < best.key)
        ) {
          best = candidate;
        }
      }
    }
  }

  if (!best) return { status: 'UNSAT', plan: null };
  return {
    status: 'SAT',
    plan: { makespan: best.makespan, peak: best.peak, jobs: best.jobs },
  };
}
