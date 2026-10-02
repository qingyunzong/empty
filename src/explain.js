import { DIMS } from './dag.js';
import { effectiveCost } from './budget.js';
import { findOptimalPlans, planCost } from './plan.js';

// Unknown historical failure rate enters as the full interval [0,1]; it is
// never a reason to consider a task unschedulable.
export function rateInterval(task) {
  return task.failRate === null ? [0, 1] : [task.failRate, task.failRate];
}

export function explainPlan(tasks, budget, opts = {}) {
  const { value, plans } = findOptimalPlans(tasks, budget, opts);
  const done = opts.done ?? new Set();
  const first = plans[0];
  const chosen = new Set(first);
  const cost = planCost(tasks, budget, first);

  const selected = first.map((id) => {
    const t = tasks.get(id);
    return { id, value: t.value, cost: effectiveCost(t, budget), failRate: rateInterval(t) };
  });

  const excluded = [];
  for (const [id, t] of [...tasks.entries()].sort()) {
    if (chosen.has(id) || done.has(id)) continue;
    let reason;
    if ((opts.exclude ?? []).includes(id)) {
      reason = 'forced-excluded';
    } else {
      const missingDep = t.deps.find((d) => !chosen.has(d) && !done.has(d));
      if (missingDep) {
        reason = `dependency "${missingDep}" not selected`;
      } else {
        const c = effectiveCost(t, budget);
        const dim = DIMS.find((d) => cost[d] + c[d] > budget[d]);
        reason = dim
          ? `insufficient budget: ${dim} would exceed (${cost[dim]}+${c[dim]} > ${budget[dim]})`
          : 'not part of an optimal-value plan';
      }
    }
    excluded.push({ id, reason });
  }

  // Plan success-probability interval: product of per-task success
  // intervals, where a task with r retries succeeds with 1 - rate^(r+1).
  let lo = 1;
  let hi = 1;
  for (const id of first) {
    const t = tasks.get(id);
    const [rlo, rhi] = rateInterval(t);
    const attempts = t.retries + 1;
    lo *= 1 - Math.pow(rhi, attempts);
    hi *= 1 - Math.pow(rlo, attempts);
  }

  const recovery = first.map((id, i) => ({
    task: id,
    onFailure: `retry "${id}" (up to ${tasks.get(id).retries} retries); checkpoint is written before completion, so resume re-uses it without repeating side effects`,
    resumeFrom: first.slice(0, i),
  }));

  return {
    optimalValue: value,
    tiedPlanCount: plans.length,
    plans,
    firstPlan: first,
    selected,
    excluded,
    budget: {
      limits: { ...budget },
      used: cost,
      remaining: Object.fromEntries(DIMS.map((d) => [d, budget[d] - cost[d]])),
    },
    successInterval: [lo, hi],
    recovery,
  };
}

export function renderExplanation(x) {
  const lines = [];
  lines.push(`optimal value: ${x.optimalValue} (${x.tiedPlanCount} tied plan(s))`);
  lines.push(`chosen plan: [${x.firstPlan.join(', ')}]`);
  lines.push(`budget used: cpu=${x.budget.used.cpu}/${x.budget.limits.cpu} mem=${x.budget.used.mem}/${x.budget.limits.mem} wall=${x.budget.used.wall}/${x.budget.limits.wall}`);
  lines.push(`success probability interval: [${x.successInterval[0]}, ${x.successInterval[1]}]`);
  if (x.selected.length > 0) {
    lines.push('selected:');
    for (const s of x.selected) {
      lines.push(`  ${s.id}: value=${s.value} cost=(cpu=${s.cost.cpu}, mem=${s.cost.mem}, wall=${s.cost.wall}) failRate in [${s.failRate[0]}, ${s.failRate[1]}]`);
    }
  }
  if (x.excluded.length > 0) {
    lines.push('excluded:');
    for (const e of x.excluded) lines.push(`  ${e.id}: ${e.reason}`);
  }
  lines.push('recovery points:');
  for (const r of x.recovery) lines.push(`  ${r.task}: ${r.onFailure}`);
  return lines.join('\n');
}
