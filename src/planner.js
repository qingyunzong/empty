import { PlanError } from './errors.js';
import { evaluate } from './parser.js';

const MAX_TASKS = 30;

function compareNameSeq(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Enumerates every candidate set deterministically and keeps all optima:
// primary objective = maximum cardinality, secondary = minimum total cost.
// Sets tied on both are all returned, sorted lexicographically by task names.
export function findOptimalPlans(validated) {
  const { tasks, budget, target, expressions } = validated;
  const n = tasks.length;
  if (n > MAX_TASKS) {
    throw new PlanError('E_TOO_MANY_TASKS', `exhaustive planning supports at most ${MAX_TASKS} tasks; got ${n}`);
  }

  let bestSize = -1;
  let bestCost = Infinity;
  let bestSets = [];

  for (let mask = 1; mask < (1 << n); mask += 1) {
    const members = [];
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) {
        members.push(tasks[i]);
        cost += tasks[i].cost;
      }
    }
    if (cost > budget) continue;

    const inSet = new Set(members.map((t) => t.name));
    let closed = true;
    for (const task of members) {
      const ast = expressions.get(task.name);
      if (ast && !evaluate(ast, (name) => inSet.has(name))) {
        closed = false;
        break;
      }
    }
    if (!closed) continue;

    const reachable = members.some((task) => task.produces.some((a) => a.name === target.artifact));
    if (!reachable) continue;

    const size = members.length;
    if (size > bestSize || (size === bestSize && cost < bestCost)) {
      bestSize = size;
      bestCost = cost;
      bestSets = [members.map((t) => t.name).sort()];
    } else if (size === bestSize && cost === bestCost) {
      bestSets.push(members.map((t) => t.name).sort());
    }
  }

  if (bestSize < 0) {
    throw new PlanError(
      'E_NO_FEASIBLE_SET',
      `no feasible task set within budget ${budget} reaches target artifact "${target.artifact}"`,
    );
  }

  bestSets.sort(compareNameSeq);
  return bestSets.map((names) => ({ tasks: names, cost: bestCost }));
}
