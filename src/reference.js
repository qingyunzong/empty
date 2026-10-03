import { compileSite, link } from './compiler.js';
import { VM } from './vm.js';
import {
  genPatterns,
  compareCandidates,
  signatureOf,
  detailKeyOf,
  evalObjective,
  objectiveMetrics,
} from './scheduler.js';
import { DENOM } from './checker.js';

function metricsOf(site, load) {
  let costNum = 0;
  let carbonNum = 0;
  let peakW = 0;
  for (let s = 0; s < site.slots; s += 1) {
    costNum += load[s] * site.priceMicro[s];
    carbonNum += load[s] * site.carbonMicro[s];
    if (load[s] > peakW) peakW = load[s];
  }
  return { costNum: costNum * site.slotMinutes, carbonNum: carbonNum * site.slotMinutes, peakW };
}

function precedenceHolds(tasks, chosen) {
  for (const t of tasks) {
    for (const other of tasks) {
      if (t === other) continue;
      const ct = chosen.get(t.id);
      const co = chosen.get(other.id);
      if (t.after.includes(other.id) && ct.first <= co.last) return false;
      if (t.before.includes(other.id) && ct.last >= co.first) return false;
    }
  }
  return true;
}

export function bruteForce(site) {
  const tasks = site.tasks;
  const n = tasks.length;
  const program = compileSite(site);
  const vm = new VM(site.slots);
  const patterns = tasks.map((t) => genPatterns(t, site));
  let best = null;
  const assign = new Array(n).fill(0);

  const consider = () => {
    const chosen = new Map();
    for (let i = 0; i < n; i += 1) chosen.set(tasks[i].id, patterns[i][assign[i]]);
    if (!precedenceHolds(tasks, chosen)) return;
    const code = link(program, tasks.map((t, i) => patterns[i][assign[i]].runs));
    const r = vm.run(code);
    if (!r.ok) return;
    const m = metricsOf(site, vm.load);
    const chosenArr = tasks.map((t, i) => patterns[i][assign[i]]);
    const cand = {
      assign: assign.slice(),
      costNum: m.costNum,
      carbonNum: m.carbonNum,
      peakW: m.peakW,
      signature: signatureOf(tasks, chosenArr),
      detailKey: detailKeyOf(tasks, chosenArr),
      load: Array.from(vm.load),
    };
    cand.objectiveValue = evalObjective(site.objective, objectiveMetrics(site, cand));
    if (!best || compareCandidates(site, cand, best) < 0) best = cand;
  };

  const rec = (i) => {
    if (i === n) {
      consider();
      return;
    }
    for (assign[i] = 0; assign[i] < patterns[i].length; assign[i] += 1) rec(i + 1);
  };
  if (patterns.every((p) => p.length > 0)) rec(0);

  if (!best) return { status: 'INFEASIBLE', budgetsExceeded: [], optimum: null, minCostNum: null };
  const budgetsExceeded = [];
  if (site.costBudget != null && best.costNum > Math.round(site.costBudget * DENOM)) {
    budgetsExceeded.push('cost');
  }
  if (site.carbonBudget != null && best.carbonNum > Math.round(site.carbonBudget * DENOM)) {
    budgetsExceeded.push('carbon');
  }
  return {
    status: budgetsExceeded.length ? 'OVER_BUDGET' : 'OK',
    budgetsExceeded,
    optimum: best,
    minCostNum: best.costNum,
  };
}
