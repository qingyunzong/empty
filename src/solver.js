import { add, sub, cmp, fmt, ZERO } from './rational.js';

function lexLess(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

// tasks: Map<id, {priority, cl, ch, dl, dh, requires: string[]}> with rational values.
// Feasible set: down-set of the precedence poset, sum(ch) <= budget, sum(dh) <= limit.
// Objective: max sum(priority); ties -> lexicographically smallest sorted id list.
export function solveSelection(tasks, budget, limit) {
  if (cmp(budget, ZERO) < 0 || cmp(limit, ZERO) < 0) {
    return { status: 'E_UNSAT', message: 'no feasible set: budget or duration limit is negative' };
  }
  const ids = [...tasks.keys()].sort();

  const ancestors = new Map();
  for (const id of ids) {
    const seen = new Set();
    const stack = [...tasks.get(id).requires];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const p of tasks.get(x).requires) stack.push(p);
    }
    ancestors.set(id, seen);
  }

  const dependents = new Map(ids.map((id) => [id, []]));
  const indeg = new Map();
  for (const id of ids) {
    indeg.set(id, tasks.get(id).requires.length);
    for (const p of tasks.get(id).requires) dependents.get(p).push(id);
  }

  const selected = new Set();
  const forbidden = new Set();
  let sumP = ZERO, sumCl = ZERO, sumCh = ZERO, sumDl = ZERO, sumDh = ZERO;
  let best = { ids: [], prio: ZERO, cl: ZERO, ch: ZERO, dl: ZERO, dh: ZERO };
  let nodes = 0;

  function positiveRemaining() {
    let s = ZERO;
    for (const id of ids) {
      if (!selected.has(id) && !forbidden.has(id)) {
        const p = tasks.get(id).priority;
        if (cmp(p, ZERO) > 0) s = add(s, p);
      }
    }
    return s;
  }

  function record() {
    const cur = [...selected].sort();
    if (cmp(sumP, best.prio) > 0 || (cmp(sumP, best.prio) === 0 && lexLess(cur, best.ids))) {
      best = { ids: cur, prio: sumP, cl: sumCl, ch: sumCh, dl: sumDl, dh: sumDh };
    }
  }

  function rec() {
    nodes++;
    if (cmp(sumCh, budget) > 0 || cmp(sumDh, limit) > 0) return;
    if (cmp(add(sumP, positiveRemaining()), best.prio) < 0) return;
    let pick = null;
    for (const id of ids) {
      if (!selected.has(id) && !forbidden.has(id) && indeg.get(id) === 0) { pick = id; break; }
    }
    if (pick === null) { record(); return; }
    const t = tasks.get(pick);
    selected.add(pick);
    sumP = add(sumP, t.priority);
    sumCl = add(sumCl, t.cl);
    sumCh = add(sumCh, t.ch);
    sumDl = add(sumDl, t.dl);
    sumDh = add(sumDh, t.dh);
    for (const d of dependents.get(pick)) indeg.set(d, indeg.get(d) - 1);
    rec();
    for (const d of dependents.get(pick)) indeg.set(d, indeg.get(d) + 1);
    sumP = sub(sumP, t.priority);
    sumCl = sub(sumCl, t.cl);
    sumCh = sub(sumCh, t.ch);
    sumDl = sub(sumDl, t.dl);
    sumDh = sub(sumDh, t.dh);
    selected.delete(pick);
    forbidden.add(pick);
    rec();
    forbidden.delete(pick);
  }
  rec();

  const reasons = {};
  for (const id of ids) {
    if (best.ids.includes(id)) continue;
    const inSet = new Set(best.ids);
    const missingAnc = [...ancestors.get(id)].filter((a) => !inSet.has(a)).sort();
    const missing = [...missingAnc, id];
    let addCh = ZERO, addDh = ZERO;
    for (const m of missing) {
      addCh = add(addCh, tasks.get(m).ch);
      addDh = add(addDh, tasks.get(m).dh);
    }
    const overBudget = cmp(add(best.ch, addCh), budget) > 0;
    const overDuration = cmp(add(best.dh, addDh), limit) > 0;
    let code;
    if (overBudget && overDuration) code = 'budget+duration';
    else if (overBudget) code = 'budget';
    else if (overDuration) code = 'duration';
    else code = 'tradeoff';
    const withAnc =
      missingAnc.length > 0 ? ` with required ancestors [${missingAnc.join(', ')}]` : '';
    reasons[id] = {
      code,
      detail: {
        budget: `adding ${id}${withAnc} would push worst-case cost to ${fmt(add(best.ch, addCh))} (budget ${fmt(budget)})`,
        duration: `adding ${id}${withAnc} would push worst-case duration to ${fmt(add(best.dh, addDh))} (limit ${fmt(limit)})`,
        'budget+duration': `adding ${id}${withAnc} would exceed both budget and duration limit`,
        tradeoff: `including ${id} does not improve the objective under the tie-break rules`,
      }[code],
    };
  }

  const certificate = {
    version: 1,
    algorithm: 'order-ideal-branch-and-bound',
    budget: fmt(budget),
    durationLimit: fmt(limit),
    selected: best.ids,
    prioritySum: fmt(best.prio),
    costInterval: [fmt(best.cl), fmt(best.ch)],
    durationInterval: [fmt(best.dl), fmt(best.dh)],
    exploredNodes: nodes,
  };

  return {
    status: 'ok',
    selected: best.ids,
    prioritySum: fmt(best.prio),
    costInterval: [fmt(best.cl), fmt(best.ch)],
    durationInterval: [fmt(best.dl), fmt(best.dh)],
    reasons,
    certificate,
  };
}

export function verifyCertificate(tasks, budget, limit, cert) {
  const checks = {};
  const sel = [...cert.selected].sort();
  const set = new Set(sel);
  checks.knownTasks = sel.every((id) => tasks.has(id));
  checks.closure =
    checks.knownTasks && sel.every((id) => tasks.get(id).requires.every((p) => set.has(p)));
  let sumP = ZERO, sumCl = ZERO, sumCh = ZERO, sumDl = ZERO, sumDh = ZERO;
  if (checks.knownTasks) {
    for (const id of sel) {
      const t = tasks.get(id);
      sumP = add(sumP, t.priority);
      sumCl = add(sumCl, t.cl);
      sumCh = add(sumCh, t.ch);
      sumDl = add(sumDl, t.dl);
      sumDh = add(sumDh, t.dh);
    }
  }
  checks.costInterval =
    fmt(sumCl) === cert.costInterval[0] && fmt(sumCh) === cert.costInterval[1];
  checks.durationInterval =
    fmt(sumDl) === cert.durationInterval[0] && fmt(sumDh) === cert.durationInterval[1];
  checks.prioritySum = fmt(sumP) === cert.prioritySum;
  checks.withinBudget = cmp(sumCh, budget) <= 0;
  checks.withinDurationLimit = cmp(sumDh, limit) <= 0;
  const resolved = solveSelection(tasks, budget, limit);
  checks.optimal =
    resolved.status === 'ok' &&
    resolved.prioritySum === cert.prioritySum &&
    JSON.stringify(resolved.selected) === JSON.stringify(sel);
  return { valid: Object.values(checks).every(Boolean), checks };
}
