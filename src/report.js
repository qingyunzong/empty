import { DIMS, effectiveCost, fits, failInterval, successInterval, attemptsInterval } from './resources.js';
import { planReport } from './planner.js';

export function fullPlanReport(dag, result) {
  return {
    value: result.value,
    budget: result.budget,
    require: result.require,
    drop: result.drop,
    planCount: result.plans.length,
    plans: result.plans.map((p) => planReport(dag, p)),
  };
}

export function taskReport(dag, budget, result, id) {
  const t = dag.tasks.get(id);
  const closure = [...dag.ancestors(id), id].sort();
  const closureCost = { cpu: 0, mem: 0, wall: 0 };
  for (const c of closure) {
    const e = effectiveCost(dag.tasks.get(c), budget);
    for (const d of DIMS) closureCost[d] += e[d];
  }
  const aloneFits = fits(closureCost, budget);
  const inPlans = [];
  result.plans.forEach((p, i) => {
    if (p.tasks.includes(id)) inPlans.push(i);
  });
  let reason;
  if (inPlans.length > 0) reason = 'selected';
  else if (!aloneFits) reason = 'infeasible: dependency closure exceeds the budget';
  else reason = 'excluded by optimality: including it lowers the achievable value under the budget';
  return {
    id,
    deps: t.deps,
    dependents: dag.dependents.get(id),
    closure,
    cost: effectiveCost(t, budget),
    closureCost,
    failRateInterval: failInterval(t),
    successInterval: successInterval(t),
    expectedAttemptsInterval: attemptsInterval(t),
    maxAttempts: t.maxRetries + 1,
    selectedInPlans: inPlans,
    reason,
  };
}
