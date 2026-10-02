export class PlanError extends Error {
  constructor(violations) {
    super('plan validation failed');
    this.name = 'PlanError';
    this.violations = violations;
  }
}

export function penalty(plan) {
  const end = new Map(plan.jobs.map((j) => [j.id, 0]));
  for (const op of plan.ops) {
    if (end.has(op.job)) end.set(op.job, Math.max(end.get(op.job), op.start + op.dur));
  }
  let total = 0;
  for (const j of plan.jobs) {
    const due = j.due ?? Infinity;
    const e = end.get(j.id) || 0;
    if (e > due) total += (j.weight ?? 1) * (e - due);
  }
  return total;
}

export function validatePlan(plan, constraints = {}) {
  const violations = [];
  const byId = new Map();
  for (const op of plan.ops) {
    if (byId.has(op.id)) violations.push({ type: 'duplicate-op', op: op.id });
    byId.set(op.id, op);
  }
  const jobIds = new Set(plan.jobs.map((j) => j.id));
  for (const op of plan.ops) {
    if (!jobIds.has(op.job)) violations.push({ type: 'unknown-job', op: op.id, job: op.job });
    if (!Number.isInteger(op.start) || op.start < 0) violations.push({ type: 'bad-start', op: op.id });
    if (!Number.isInteger(op.dur) || op.dur <= 0) violations.push({ type: 'bad-duration', op: op.id });
    const caps = op.machines && op.machines.length ? op.machines : [op.machine];
    if (!caps.includes(op.machine)) violations.push({ type: 'capability', op: op.id, machine: op.machine });
    for (const p of op.preds || []) if (!byId.has(p)) violations.push({ type: 'missing-pred', op: op.id, pred: p });
  }
  const indeg = new Map();
  const adj = new Map();
  for (const op of plan.ops) { indeg.set(op.id, 0); adj.set(op.id, []); }
  for (const op of plan.ops) {
    for (const p of op.preds || []) {
      if (byId.has(p)) { adj.get(p).push(op.id); indeg.set(op.id, indeg.get(op.id) + 1); }
    }
  }
  const queue = plan.ops.filter((o) => indeg.get(o.id) === 0).map((o) => o.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop();
    seen++;
    for (const n of adj.get(id)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  if (seen !== plan.ops.length) violations.push({ type: 'precedence-cycle' });
  for (const op of plan.ops) {
    for (const p of op.preds || []) {
      const pr = byId.get(p);
      if (pr && pr.start + pr.dur > op.start) violations.push({ type: 'precedence', op: op.id, pred: p });
    }
  }
  const byMachine = new Map();
  for (const op of plan.ops) {
    if (!byMachine.has(op.machine)) byMachine.set(op.machine, []);
    byMachine.get(op.machine).push(op);
  }
  for (const [machine, list] of byMachine) {
    list.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (list[i].start < prev.start + prev.dur) {
        violations.push({ type: 'overlap', machine, ops: [prev.id, list[i].id] });
      }
    }
  }
  if (constraints.budget != null) {
    const pen = penalty(plan);
    if (pen > constraints.budget) violations.push({ type: 'budget', penalty: pen, budget: constraints.budget });
  }
  return violations;
}

export function applyChange(plan, change) {
  const p = structuredClone(plan);
  if (change.type === 'insert') {
    const o = change.op || {};
    const violations = [];
    for (const f of ['id', 'job', 'machine', 'start', 'dur']) {
      if (o[f] === undefined) violations.push({ type: 'missing-field', op: o.id, field: f });
    }
    if (violations.length) throw new PlanError(violations);
    if (p.ops.some((x) => x.id === o.id)) violations.push({ type: 'duplicate-op', op: o.id });
    if (!p.jobs.some((j) => j.id === o.job)) violations.push({ type: 'unknown-job', op: o.id, job: o.job });
    if (violations.length) throw new PlanError(violations);
    p.ops.push({ preds: [], machines: [o.machine], ...structuredClone(o) });
    return p;
  }
  if (change.type === 'move') {
    const t = p.ops.find((x) => x.id === change.op?.id);
    if (!t) throw new PlanError([{ type: 'unknown-op', op: change.op?.id }]);
    if (change.op.machine !== undefined) t.machine = change.op.machine;
    if (change.op.start !== undefined) t.start = change.op.start;
    return p;
  }
  if (change.type === 'cancel') {
    const i = p.ops.findIndex((x) => x.id === change.op?.id);
    if (i < 0) throw new PlanError([{ type: 'unknown-op', op: change.op?.id }]);
    if (p.ops.some((x) => (x.preds || []).includes(change.op.id))) {
      throw new PlanError([{ type: 'has-dependents', op: change.op.id }]);
    }
    p.ops.splice(i, 1);
    return p;
  }
  throw new PlanError([{ type: 'unknown-change-type', changeType: change.type }]);
}
