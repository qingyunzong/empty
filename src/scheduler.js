import { compileSite, link } from './compiler.js';
import { VM } from './vm.js';
import { DENOM } from './checker.js';

const MAX_PATTERNS = 200000;

export function genPatterns(task, site) {
  const { winStart, winEnd, durationSlots } = task;
  const { blocked } = site;
  const patterns = [];
  const push = (slotsList) => {
    const runs = [];
    let runStart = slotsList[0];
    for (let k = 1; k <= slotsList.length; k += 1) {
      if (k === slotsList.length || slotsList[k] !== slotsList[k - 1] + 1) {
        runs.push([runStart, slotsList[k - 1] + 1]);
        if (k < slotsList.length) runStart = slotsList[k];
      }
    }
    patterns.push({
      slots: slotsList,
      runs,
      first: slotsList[0],
      last: slotsList[slotsList.length - 1],
    });
  };

  if (!task.interruptible) {
    for (let s = winStart; s + durationSlots <= winEnd; s += 1) {
      let ok = true;
      for (let k = s; k < s + durationSlots; k += 1) {
        if (blocked[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const slotsList = [];
      for (let k = s; k < s + durationSlots; k += 1) slotsList.push(k);
      push(slotsList);
    }
    return patterns;
  }

  const maxRuns = task.maxInterrupts == null ? durationSlots : task.maxInterrupts + 1;
  const chosen = [];
  const rec = (slot) => {
    if (patterns.length > MAX_PATTERNS) {
      throw new Error(`task '${task.id}': too many candidate schedules to enumerate (window too large)`);
    }
    if (chosen.length === durationSlots) {
      let runs = 1;
      for (let k = 1; k < chosen.length; k += 1) {
        if (chosen[k] !== chosen[k - 1] + 1) runs += 1;
      }
      if (runs <= maxRuns) push(chosen.slice());
      return;
    }
    for (let s = slot; s < winEnd; s += 1) {
      if (chosen.length + (winEnd - s) < durationSlots) break;
      if (blocked[s]) continue;
      chosen.push(s);
      rec(s + 1);
      chosen.pop();
    }
  };
  rec(winStart);
  return patterns;
}

export function evalObjective(expr, metrics) {
  switch (expr.kind) {
    case 'num':
      return Number(expr.text);
    case 'var':
      return metrics[expr.name];
    case 'neg':
      return -evalObjective(expr.expr, metrics);
    case 'bin': {
      const l = evalObjective(expr.left, metrics);
      const r = evalObjective(expr.right, metrics);
      switch (expr.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        default:
          throw new Error(`unknown operator '${expr.op}'`);
      }
    }
    default:
      throw new Error(`unknown objective node '${expr.kind}'`);
  }
}

function metricsOf(site, load) {
  let costNum = 0;
  let carbonNum = 0;
  let peakW = 0;
  for (let s = 0; s < site.slots; s += 1) {
    costNum += load[s] * site.priceMicro[s];
    carbonNum += load[s] * site.carbonMicro[s];
    if (load[s] > peakW) peakW = load[s];
  }
  costNum *= site.slotMinutes;
  carbonNum *= site.slotMinutes;
  return { costNum, carbonNum, peakW };
}

export function objectiveMetrics(site, cand) {
  return {
    cost: cand.costNum / DENOM,
    peak: cand.peakW / 1000,
    carbon: cand.carbonNum / DENOM,
  };
}

export function compareCandidates(site, a, b) {
  if (a.objectiveValue !== b.objectiveValue) return a.objectiveValue < b.objectiveValue ? -1 : 1;
  if (a.peakW !== b.peakW) return a.peakW < b.peakW ? -1 : 1;
  if (a.signature !== b.signature) return a.signature < b.signature ? -1 : 1;
  if (a.detailKey !== b.detailKey) return a.detailKey < b.detailKey ? -1 : 1;
  return 0;
}

export function signatureOf(tasks, chosen) {
  const entries = tasks.map((t, i) => ({ id: t.id, first: chosen[i].first }));
  entries.sort((x, y) => x.first - y.first || (x.id < y.id ? -1 : 1));
  return entries.map((e) => e.id).join(',');
}

export function detailKeyOf(tasks, chosen) {
  const entries = tasks.map((t, i) => ({ id: t.id, slots: chosen[i].slots }));
  entries.sort((x, y) => (x.id < y.id ? -1 : 1));
  return entries.map((e) => `${e.id}:${e.slots.join('+')}`).join('|');
}

function precedenceOk(tasks, patterns, assign, ti, pat) {
  const t = tasks[ti];
  for (let j = 0; j < tasks.length; j += 1) {
    if (j === ti || assign[j] < 0) continue;
    const other = tasks[j];
    const pj = patterns[j][assign[j]];
    if (t.after.includes(other.id) && pat.first <= pj.last) return false;
    if (t.before.includes(other.id) && pat.last >= pj.first) return false;
    if (other.after.includes(t.id) && pj.first <= pat.last) return false;
    if (other.before.includes(t.id) && pj.last >= pat.first) return false;
  }
  return true;
}

function finish(site, best) {
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

function makeCandidate(site, tasks, patterns, assign, metrics, load) {
  const chosen = tasks.map((t, i) => patterns[i][assign[i]]);
  const cand = {
    assign: assign.slice(),
    slotLists: chosen.map((p) => p.slots),
    runsLists: chosen.map((p) => p.runs),
    costNum: metrics.costNum,
    carbonNum: metrics.carbonNum,
    peakW: metrics.peakW,
    signature: signatureOf(tasks, chosen),
    detailKey: detailKeyOf(tasks, chosen),
    load: Array.from(load),
  };
  cand.objectiveValue = evalObjective(site.objective, objectiveMetrics(site, cand));
  return cand;
}

export function solveSite(site) {
  const tasks = site.tasks;
  const n = tasks.length;
  const program = compileSite(site);
  const vm = new VM(site.slots);
  const patterns = tasks.map((t) => genPatterns(t, site));

  if (tasks.some((t, i) => patterns[i].length === 0)) return finish(site, null);

  const patternCost = patterns.map((pats, i) => pats.map((p) => {
    let sum = 0;
    for (const s of p.slots) sum += site.priceMicro[s];
    return site.slotMinutes * tasks[i].watts * sum;
  }));

  const objectiveIsCost = site.objective.kind === 'var' && site.objective.name === 'cost';
  const order = tasks.map((_, i) => i).sort((a, b) => {
    if (patterns[a].length !== patterns[b].length) return patterns[a].length - patterns[b].length;
    return tasks[a].id < tasks[b].id ? -1 : 1;
  });

  const assign = new Array(n).fill(-1);
  const loadInc = new Float64Array(site.slots);
  let best = null;

  const dfs = (depth, costNumSoFar) => {
    if (depth === n) {
      const code = link(program, tasks.map((t, i) => patterns[i][assign[i]].runs));
      const r = vm.run(code);
      if (!r.ok) return;
      const cand = makeCandidate(site, tasks, patterns, assign, metricsOf(site, vm.load), vm.load);
      if (!best || compareCandidates(site, cand, best) < 0) best = cand;
      return;
    }
    const ti = order[depth];
    const t = tasks[ti];
    for (let pi = 0; pi < patterns[ti].length; pi += 1) {
      const pat = patterns[ti][pi];
      if (!precedenceOk(tasks, patterns, assign, ti, pat)) continue;
      let fits = true;
      for (const s of pat.slots) {
        loadInc[s] += t.watts;
        if (site.peakLimitW != null && loadInc[s] > site.peakLimitW) fits = false;
      }
      const newCost = costNumSoFar + patternCost[ti][pi];
      if (fits && !(objectiveIsCost && best && newCost > best.costNum)) {
        assign[ti] = pi;
        dfs(depth + 1, newCost);
        assign[ti] = -1;
      }
      for (const s of pat.slots) loadInc[s] -= t.watts;
    }
  };
  dfs(0, 0);
  return finish(site, best);
}

function taskKey(t) {
  return JSON.stringify({
    id: t.id,
    watts: t.watts,
    durationSlots: t.durationSlots,
    winStart: t.winStart,
    winEnd: t.winEnd,
    interruptible: t.interruptible,
    maxInterrupts: t.maxInterrupts,
    after: t.after,
    before: t.before,
  });
}

export class Scheduler {
  constructor(site) {
    this.site = site;
    this.tasks = site.tasks.slice();
    this.savepoints = new Map();
    this.cache = new Map();
  }

  addTask(task) {
    if (this.tasks.some((t) => t.id === task.id)) {
      throw new Error(`duplicate task id '${task.id}'`);
    }
    this.tasks.push(task);
  }

  savepoint(name) {
    this.savepoints.set(name, this.tasks.slice());
  }

  rollback(name) {
    if (!this.savepoints.has(name)) throw new Error(`unknown savepoint '${name}'`);
    this.tasks = this.savepoints.get(name).slice();
  }

  stateKey() {
    const siteKey = JSON.stringify({
      slots: this.site.slots,
      slotMinutes: this.site.slotMinutes,
      priceMicro: this.site.priceMicro,
      carbonMicro: this.site.carbonMicro,
      costBudget: this.site.costBudget,
      carbonBudget: this.site.carbonBudget,
      peakLimitW: this.site.peakLimitW,
      blocked: Array.from(this.site.blocked),
      objective: JSON.stringify(this.site.objective),
    });
    const tasksKey = this.tasks.map(taskKey).sort().join('#');
    return `${siteKey}|${tasksKey}`;
  }

  solve() {
    const key = this.stateKey();
    if (this.cache.has(key)) return this.cache.get(key);
    const result = solveSite({ ...this.site, tasks: this.tasks.slice() });
    this.cache.set(key, result);
    return result;
  }
}
