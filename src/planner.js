import { PlannerError, CODES } from './errors.js';
import { evalExpression } from './expr.js';
import { validateSpec } from './spec.js';

const MAX_TASKS = 24; // exhaustive enumeration guard (2^24 subsets)

function artifactsOf(spec, mask) {
  const available = new Set();
  for (let i = 0; i < spec.tasks.length; i += 1) {
    if (mask & (1 << i)) {
      for (const p of spec.tasks[i].produces) available.add(p.name);
    }
  }
  return available;
}

function isClosed(spec, mask, available) {
  for (let i = 0; i < spec.tasks.length; i += 1) {
    if (!(mask & (1 << i))) continue;
    const req = spec.tasks[i].requires;
    if (req && !evalExpression(req, available)) return false;
  }
  return true;
}

function compareNameLists(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Finds all tied-optimal feasible task sets:
//   feasible  = dependency-closed, total cost <= budget, all targets produced
//   optimal   = maximum set cardinality, then minimum total cost
// Every set tied on (size, cost) is returned, sorted lexicographically by
// sorted task-name sequence. Nothing is chosen arbitrarily.
export function plan(rawSpec) {
  const spec = validateSpec(rawSpec);
  const n = spec.tasks.length;
  if (n > MAX_TASKS) {
    throw new PlannerError(CODES.TOO_MANY_TASKS, `exhaustive planner supports at most ${MAX_TASKS} tasks, got ${n}`);
  }

  let best = null; // { size, cost, sets: string[][] }
  const total = 1 << n;
  for (let mask = 0; mask < total; mask += 1) {
    let cost = 0;
    let size = 0;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) { cost += spec.tasks[i].cost; size += 1; }
    }
    if (cost > spec.budget) continue;
    const available = artifactsOf(spec, mask);
    if (!isClosed(spec, mask, available)) continue;
    if (!spec.targets.every((t) => available.has(t))) continue;

    const names = spec.tasks.filter((_, i) => mask & (1 << i)).map((t) => t.name).sort();
    if (!best || size > best.size || (size === best.size && cost < best.cost)) {
      best = { size, cost, sets: [names] };
    } else if (size === best.size && cost === best.cost) {
      best.sets.push(names);
    }
  }

  if (!best) {
    throw new PlannerError(
      CODES.NO_FEASIBLE,
      `no feasible task set: budget ${spec.budget} cannot reach targets ${JSON.stringify(spec.targets)}`,
    );
  }

  best.sets.sort(compareNameLists);
  return {
    size: best.size,
    cost: best.cost,
    plans: best.sets,
    targets: [...spec.targets],
    budget: spec.budget,
  };
}
