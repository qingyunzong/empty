import { validation } from './errors.js';

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw validation('plan must be an object');
  if (!Array.isArray(plan.machines) || plan.machines.length === 0) throw validation('plan.machines must be a non-empty array');
  if (!Array.isArray(plan.jobs)) throw validation('plan.jobs must be an array');
  if (typeof plan.budget !== 'number' || plan.budget < 0) throw validation('plan.budget must be a number >= 0');
  const machineIds = new Set();
  for (const m of plan.machines) {
    if (!m.id || machineIds.has(m.id)) throw validation('machine ids must be unique non-empty strings');
    machineIds.add(m.id);
    if (!Array.isArray(m.caps)) throw validation(`machine ${m.id} requires caps array`);
  }
  const opIds = new Set();
  for (const j of plan.jobs) {
    if (!j.id) throw validation('job requires id');
    if (!Array.isArray(j.ops) || j.ops.length === 0) throw validation(`job ${j.id} requires non-empty ops`);
    if (typeof j.due !== 'number' || j.due < 0) throw validation(`job ${j.id} requires due >= 0`);
    if ((j.weight ?? 1) < 0) throw validation(`job ${j.id} weight must be >= 0`);
    for (const o of j.ops) {
      const id = `${j.id}.${o.id}`;
      if (!o.id || opIds.has(id)) throw validation(`duplicate or missing op id: ${id}`);
      opIds.add(id);
      if (!o.cap || !(o.dur > 0)) throw validation(`op ${id} requires cap and dur > 0`);
    }
  }
  if (plan.schedule !== undefined) {
    if (!plan.schedule || typeof plan.schedule !== 'object' || Array.isArray(plan.schedule))
      throw validation('plan.schedule must be an object mapping machine id to op id list');
    const seen = new Set();
    for (const [m, list] of Object.entries(plan.schedule)) {
      if (!machineIds.has(m)) throw validation(`schedule references unknown machine ${m}`);
      if (!Array.isArray(list)) throw validation(`schedule for ${m} must be an array`);
      for (const id of list) {
        if (!opIds.has(id)) throw validation(`schedule references unknown op ${id}`);
        if (seen.has(id)) throw validation(`op ${id} placed twice in schedule`);
        seen.add(id);
      }
    }
  }
}

export function initialDyn(plan) {
  const order = {};
  for (const m of plan.machines) order[m.id] = [];
  if (plan.schedule) {
    for (const [m, list] of Object.entries(plan.schedule)) order[m] = [...list];
  } else {
    for (const j of plan.jobs) {
      for (const o of j.ops) {
        const id = `${j.id}.${o.id}`;
        const m = plan.machines.find((mm) => mm.caps.includes(o.cap));
        if (!m) throw validation(`no capable machine for op ${id}`);
        order[m.id].push(id);
      }
    }
  }
  return { order, cancelled: [], addedOps: [] };
}

export function opTable(plan, dyn) {
  const cancelled = new Set(dyn.cancelled);
  const defs = new Map();
  const chains = new Map();
  for (const j of plan.jobs) {
    chains.set(j.id, j.ops.map((o) => `${j.id}.${o.id}`));
    for (const o of j.ops) {
      const id = `${j.id}.${o.id}`;
      defs.set(id, { id, job: j.id, cap: o.cap, dur: o.dur });
    }
  }
  for (const ao of dyn.addedOps) {
    if (!chains.has(ao.job)) chains.set(ao.job, []);
    chains.get(ao.job).push(ao.id);
    defs.set(ao.id, { id: ao.id, job: ao.job, cap: ao.cap, dur: ao.dur });
  }
  const ops = new Map();
  for (const list of chains.values()) {
    let prev = null;
    for (const id of list) {
      if (cancelled.has(id)) continue;
      ops.set(id, { ...defs.get(id), pred: prev });
      prev = id;
    }
  }
  return ops;
}

export function computeTimes(plan, dyn) {
  const ops = opTable(plan, dyn);
  const machineIds = plan.machines.map((m) => m.id);
  const queues = {};
  for (const m of machineIds) queues[m] = (dyn.order[m] ?? []).filter((id) => ops.has(id));
  const machineFree = {};
  const start = {};
  const end = {};
  let remaining = 0;
  for (const m of machineIds) remaining += queues[m].length;
  while (remaining > 0) {
    let best = null;
    for (const m of machineIds) {
      const head = queues[m].find((id) => end[id] === undefined);
      if (head === undefined) continue;
      const op = ops.get(head);
      if (op.pred && end[op.pred] === undefined) continue;
      const s = Math.max(machineFree[m] ?? 0, op.pred ? end[op.pred] : 0);
      if (!best || s < best.s || (s === best.s && m < best.m)) best = { m, id: head, s };
    }
    if (!best) throw validation('scheduling deadlock: precedence cycle or missing predecessor');
    start[best.id] = best.s;
    end[best.id] = best.s + ops.get(best.id).dur;
    machineFree[best.m] = end[best.id];
    remaining--;
  }
  const jobEnd = {};
  for (const [id, op] of ops) jobEnd[op.job] = Math.max(jobEnd[op.job] ?? 0, end[id]);
  let cost = 0;
  const tardiness = {};
  for (const j of plan.jobs) {
    const t = jobEnd[j.id] === undefined ? 0 : Math.max(0, jobEnd[j.id] - j.due);
    tardiness[j.id] = t;
    cost += t * (j.weight ?? 1);
  }
  return { start, end, jobEnd, tardiness, cost };
}

export function validate(plan, dyn) {
  const violations = [];
  const ops = opTable(plan, dyn);
  const caps = new Map(plan.machines.map((m) => [m.id, new Set(m.caps)]));
  const seen = new Set();
  let structural = false;
  for (const [m, list] of Object.entries(dyn.order)) {
    if (!caps.has(m)) { violations.push({ code: 'UNKNOWN_MACHINE', machine: m }); structural = true; continue; }
    for (const id of list) {
      if (!ops.has(id)) { violations.push({ code: 'UNKNOWN_OP', op: id, machine: m }); structural = true; continue; }
      if (seen.has(id)) { violations.push({ code: 'DUPLICATE_OP', op: id }); structural = true; }
      seen.add(id);
      if (!caps.get(m).has(ops.get(id).cap))
        violations.push({ code: 'CAPABILITY', op: id, machine: m, cap: ops.get(id).cap });
    }
  }
  for (const id of ops.keys()) {
    if (!seen.has(id)) { violations.push({ code: 'UNPLACED', op: id }); structural = true; }
  }
  let times = null;
  if (!structural) {
    try {
      times = computeTimes(plan, dyn);
    } catch {
      violations.push({ code: 'PRECEDENCE', detail: 'machine order conflicts with operation precedence' });
      return { violations, times: null };
    }
    for (const [id, op] of ops) {
      if (op.pred && times.start[id] < times.end[op.pred])
        violations.push({ code: 'PRECEDENCE', op: id, pred: op.pred });
    }
    if (times.cost > plan.budget)
      violations.push({ code: 'BUDGET', cost: times.cost, budget: plan.budget });
  }
  return { violations, times };
}
