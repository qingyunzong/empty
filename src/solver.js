import { validateInput } from './model.js';

class BudgetExhausted extends Error {}

export function cleaningTime(model, fromMaterial, toMaterial) {
  if (fromMaterial === null || toMaterial === null) return 0; // holds: no wash, just no overlap
  if (fromMaterial === toMaterial) return 0;
  const key = `${fromMaterial}->${toMaterial}`;
  if (model.cleaningMap.has(key)) return model.cleaningMap.get(key);
  return model.defaultCleaningTime;
}

function effectiveHorizon(model, tasks) {
  if (model.horizon !== null) return model.horizon;
  let maxDeadline = 0;
  let sumDuration = 0;
  let maxEarliest = 0;
  let open = false;
  for (const t of tasks) {
    sumDuration += t.duration;
    if (t.earliestStart > maxEarliest) maxEarliest = t.earliestStart;
    if (t.deadline !== null) {
      if (t.deadline > maxDeadline) maxDeadline = t.deadline;
    } else {
      open = true;
    }
  }
  if (!open) return maxDeadline;
  const maxClean = Math.max(model.defaultCleaningTime, ...model.cleaningMap.values(), 0);
  return maxEarliest + sumDuration + maxClean * tasks.length + 1;
}

// Tanks a task may use after unary capacity / compatibility / pinning restrictions.
export function unaryTankDomain(model, task) {
  const out = [];
  for (let i = 0; i < model.tanks.length; i++) {
    const tank = model.tanks[i];
    if (task.tank !== null && tank.id !== task.tank) continue;
    if (task.material !== null && !tank.materials.has(task.material)) continue;
    if (tank.capacity < task.minCapacity || tank.capacity > task.maxCapacity) continue;
    out.push(i);
  }
  return out;
}

function initDomains(model, tasks, horizon) {
  return tasks.map((t) => {
    const tanks = new Set(unaryTankDomain(model, t));
    const deadline = t.deadline === null ? horizon : Math.min(t.deadline, horizon);
    const starts = new Set();
    if (t.locked) {
      if (t.start + t.duration <= deadline) starts.add(t.start);
    } else {
      for (let s = t.earliestStart; s + t.duration <= deadline; s++) starts.add(s);
    }
    return { tanks, starts };
  });
}

function separated(model, a, sa, b, sb) {
  return (
    sa + a.duration + cleaningTime(model, a.material, b.material) <= sb ||
    sb + b.duration + cleaningTime(model, b.material, a.material) <= sa
  );
}

// Arc-consistency on the disjunctive cleaning constraint for two tasks
// that are both forced onto the same tank. Returns false on empty domain.
function prunePair(model, ta, da, tb, db) {
  let changed = false;
  for (const sa of [...da.starts]) {
    let ok = false;
    for (const sb of db.starts) {
      if (separated(model, ta, sa, tb, sb)) { ok = true; break; }
    }
    if (!ok) { da.starts.delete(sa); changed = true; }
  }
  if (da.starts.size === 0) return { ok: false, changed };
  for (const sb of [...db.starts]) {
    let ok = false;
    for (const sa of da.starts) {
      if (separated(model, ta, sa, tb, sb)) { ok = true; break; }
    }
    if (!ok) { db.starts.delete(sb); changed = true; }
  }
  return { ok: db.starts.size > 0, changed };
}

function propagate(model, tasks, domains) {
  for (const d of domains) {
    if (d.tanks.size === 0 || d.starts.size === 0) return false;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const di = domains[i];
        const dj = domains[j];
        if (di.tanks.size !== 1 || dj.tanks.size !== 1) continue;
        const [ti] = di.tanks;
        const [tj] = dj.tanks;
        if (ti !== tj) continue;
        const r = prunePair(model, tasks[i], di, tasks[j], dj);
        if (!r.ok) return false;
        if (r.changed) changed = true;
      }
    }
  }
  return true;
}

function cloneDomains(domains) {
  return domains.map((d) => ({ tanks: new Set(d.tanks), starts: new Set(d.starts) }));
}

function isComplete(domains) {
  return domains.every((d) => d.tanks.size === 1 && d.starts.size === 1);
}

function search(model, tasks, domains, ctx) {
  ctx.nodes += 1;
  if (ctx.nodes > ctx.budget) throw new BudgetExhausted();
  if (!propagate(model, tasks, domains)) return null;

  let assigned = 0;
  for (const d of domains) {
    if (d.tanks.size === 1 && d.starts.size === 1) assigned += 1;
  }
  if (assigned > ctx.best.count) {
    ctx.best = { count: assigned, domains: cloneDomains(domains) };
  }
  if (assigned === tasks.length) return domains;

  let pick = -1;
  let pickSize = Infinity;
  for (let i = 0; i < domains.length; i++) {
    const size = domains[i].tanks.size * domains[i].starts.size;
    if (size > 1 && size < pickSize) {
      pickSize = size;
      pick = i;
    }
  }

  const d = domains[pick];
  if (d.tanks.size > 1) {
    for (const t of [...d.tanks].sort((a, b) => a - b)) {
      const next = cloneDomains(domains);
      next[pick].tanks = new Set([t]);
      const r = search(model, tasks, next, ctx);
      if (r) return r;
    }
  } else {
    for (const s of [...d.starts].sort((a, b) => a - b)) {
      const next = cloneDomains(domains);
      next[pick].starts = new Set([s]);
      const r = search(model, tasks, next, ctx);
      if (r) return r;
    }
  }
  return null;
}

function buildAssignment(model, tasks, domains) {
  const assignment = {};
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].isHold) continue;
    const [tankIdx] = domains[i].tanks;
    const [start] = domains[i].starts;
    assignment[tasks[i].id] = {
      tank: model.tanks[tankIdx].id,
      start,
      end: start + tasks[i].duration,
    };
  }
  return assignment;
}

export function solveModel(model, tasks, { budget } = {}) {
  const horizon = effectiveHorizon(model, tasks);
  const domains = initDomains(model, tasks, horizon);
  const ctx = {
    budget: budget ?? model.budget,
    nodes: 0,
    best: { count: -1, domains: cloneDomains(domains) },
  };
  let solved = null;
  let exhausted = false;
  try {
    solved = search(model, tasks, domains, ctx);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    exhausted = true;
  }
  if (solved) {
    return { status: 'feasible', assignment: buildAssignment(model, tasks, solved), nodes: ctx.nodes };
  }
  if (exhausted) {
    const pending = [];
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].isHold) continue;
      const d = ctx.best.domains[i];
      if (!(d.tanks.size === 1 && d.starts.size === 1)) pending.push(tasks[i].id);
    }
    return { status: 'unknown', pending, nodes: ctx.nodes };
  }
  return { status: 'infeasible', nodes: ctx.nodes };
}

// Deletion-based minimization: drop any unlocked, non-hold task while the
// remaining set stays infeasible. Locked tasks and holds are fixed context.
function minimalConflictTasks(model, tasks) {
  let core = [...tasks];
  for (const t of [...core]) {
    if (t.locked || t.isHold) continue;
    const trial = core.filter((x) => x !== t);
    const r = solveModel(model, trial, { budget: 200000 });
    if (r.status === 'infeasible') core = trial;
  }
  return core;
}

function describeConflict(model, core) {
  const tankSet = new Set();
  const domainsByTask = new Map();
  for (const t of core) {
    const dom = unaryTankDomain(model, t);
    domainsByTask.set(t.id, new Set(dom));
    for (const i of dom) tankSet.add(model.tanks[i].id);
  }
  const rules = [];
  const seen = new Set();
  for (const a of core) {
    for (const b of core) {
      if (a === b || a.material === null || b.material === null || a.material === b.material) continue;
      const time = cleaningTime(model, a.material, b.material);
      if (time <= 0) continue;
      const shared = [...domainsByTask.get(a.id)].some((i) => domainsByTask.get(b.id).has(i));
      if (!shared) continue;
      const key = `${a.material}->${b.material}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ from: a.material, to: b.material, time });
    }
  }
  return {
    tasks: core.filter((t) => !t.isHold).map((t) => t.id),
    holds: core.filter((t) => t.isHold).map((t) => t.id),
    tanks: [...tankSet],
    cleaningRules: rules,
  };
}

export function solveWithConflict(rawInput, options = {}) {
  const model = validateInput(rawInput);
  const tasks = [...model.tasks, ...model.holds];
  const budget = options.budget ?? model.budget;
  const result = solveModel(model, tasks, { budget });
  if (result.status === 'infeasible') {
    const core = minimalConflictTasks(model, tasks);
    result.conflict = describeConflict(model, core);
  }
  return result;
}

export function solveProblem(rawInput, options = {}) {
  return solveWithConflict(rawInput, options);
}

// Independent checker: validate a complete assignment against the model.
export function verifyAssignment(rawInput, assignment) {
  const model = validateInput(rawInput);
  const tasks = [...model.tasks, ...model.holds];
  const horizon = effectiveHorizon(model, tasks);
  for (const t of tasks) {
    if (t.isHold) continue;
    const a = assignment[t.id];
    if (!a) return { ok: false, reason: `task ${t.id} not assigned` };
    const tankIdx = model.tankIndex.get(a.tank);
    if (tankIdx === undefined) return { ok: false, reason: `task ${t.id}: unknown tank ${a.tank}` };
    if (!unaryTankDomain(model, t).includes(tankIdx)) {
      return { ok: false, reason: `task ${t.id}: tank ${a.tank} violates capacity/compatibility/pin` };
    }
    if (!Number.isInteger(a.start) || a.start < t.earliestStart) {
      return { ok: false, reason: `task ${t.id}: start ${a.start} before earliestStart` };
    }
    const deadline = t.deadline === null ? horizon : Math.min(t.deadline, horizon);
    if (a.start + t.duration > deadline) return { ok: false, reason: `task ${t.id}: misses deadline` };
    if (t.locked && a.start !== t.start) return { ok: false, reason: `task ${t.id}: locked task moved` };
    if (t.locked && t.tank !== null && a.tank !== t.tank) return { ok: false, reason: `task ${t.id}: locked tank changed` };
  }
  const placed = [];
  for (const t of tasks) {
    if (t.isHold) {
      placed.push({ t, tank: t.tank, start: t.start });
    } else {
      placed.push({ t, tank: assignment[t.id].tank, start: assignment[t.id].start });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i];
      const q = placed[j];
      if (p.tank !== q.tank) continue;
      if (!separated(model, p.t, p.start, q.t, q.start)) {
        return { ok: false, reason: `tasks ${p.t.id} and ${q.t.id} overlap on ${p.tank} (cleaning violated)` };
      }
    }
  }
  return { ok: true };
}
