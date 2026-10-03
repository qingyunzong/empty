// Core domain model: jobs, molds, calendar, budget, changes, batches.
// Pure data + invariants; no I/O lives here.

export class MoldPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MoldPlanError';
    this.code = code;
    this.details = details;
  }
}

export function emptyState() {
  return {
    jobs: new Map(), // id -> { id, units, eligible: [moldId...] }
    molds: new Map(), // id -> { id, life, changeTime, locked }
    calendar: { shifts: [] }, // [{ id, budget }]
    assignment: new Map(), // jobId -> { shift, mold }
    batches: [], // [{ id, seq, changes: [Change], lockedMolds: [moldId...] }]
    nextBatchSeq: 1,
    nextChangeSeq: 1,
    // Recomputed incrementally after every change:
    usage: new Map(), // moldId -> units consumed
    shiftLoad: [], // units per shift index
    moldShifts: new Map(), // moldId -> Set(shiftIdx)
    pending: [], // over-allocation flags [{ mold, used, life }]
    feasible: false,
    certificate: null, // last feasible plan certificate (never clobbered by infeasible states)
  };
}

export function cloneState(s) {
  return {
    jobs: new Map([...s.jobs].map(([k, v]) => [k, { ...v, eligible: [...v.eligible] }])),
    molds: new Map([...s.molds].map(([k, v]) => [k, { ...v }])),
    calendar: { shifts: s.calendar.shifts.map((x) => ({ ...x })) },
    assignment: new Map([...s.assignment].map(([k, v]) => [k, { ...v }])),
    batches: s.batches.map((b) => ({
      ...b,
      lockedMolds: [...b.lockedMolds],
      changes: b.changes.map((c) => ({ ...c, inverse: { ...c.inverse } })),
    })),
    nextBatchSeq: s.nextBatchSeq,
    nextChangeSeq: s.nextChangeSeq,
    usage: new Map(s.usage),
    shiftLoad: [...s.shiftLoad],
    moldShifts: new Map([...s.moldShifts].map(([k, v]) => [k, new Set(v)])),
    pending: s.pending.map((p) => ({ ...p })),
    feasible: s.feasible,
    certificate: s.certificate ? JSON.parse(JSON.stringify(s.certificate)) : null,
  };
}

function requireJob(state, jobId) {
  const job = state.jobs.get(jobId);
  if (!job) throw new MoldPlanError('MODEL', `unknown job: ${jobId}`, { job: jobId });
  return job;
}

function requireMold(state, moldId) {
  const mold = state.molds.get(moldId);
  if (!mold) throw new MoldPlanError('MODEL', `unknown mold: ${moldId}`, { mold: moldId });
  return mold;
}

function requireShift(state, shiftIdx) {
  if (!Number.isInteger(shiftIdx) || shiftIdx < 0 || shiftIdx >= state.calendar.shifts.length) {
    throw new MoldPlanError('MODEL', `unknown shift index: ${shiftIdx}`, { shift: shiftIdx });
  }
  return state.calendar.shifts[shiftIdx];
}

// ---- change application -------------------------------------------------
// Each change returns its inverse (enough information to undo exactly).

export function applyChange(state, change) {
  switch (change.type) {
    case 'noop':
      return { type: 'noop' };
    case 'addJob': {
      if (state.jobs.has(change.job.id)) {
        const existing = state.jobs.get(change.job.id);
        const same =
          existing.units === change.job.units &&
          JSON.stringify(existing.eligible) === JSON.stringify([...change.job.eligible].sort());
        if (same) return { type: 'noop' }; // concurrent identical insert (sync)
        throw new MoldPlanError('MODEL', `conflicting job insert: ${change.job.id}`);
      }
      const job = {
        id: change.job.id,
        units: change.job.units,
        eligible: [...change.job.eligible].sort(),
      };
      for (const m of job.eligible) requireMold(state, m);
      state.jobs.set(job.id, job);
      return { type: 'removeJob', jobId: job.id };
    }
    case 'removeJob': {
      const job = requireJob(state, change.jobId);
      if (state.assignment.has(change.jobId)) {
        throw new MoldPlanError('MODEL', `cannot remove assigned job: ${change.jobId}`);
      }
      state.jobs.delete(change.jobId);
      return { type: 'addJob', job: { ...job, eligible: [...job.eligible] } };
    }
    case 'addMold': {
      if (state.molds.has(change.mold.id)) {
        const existing = state.molds.get(change.mold.id);
        if (existing.life === change.mold.life && existing.changeTime === change.mold.changeTime) {
          return { type: 'noop' }; // concurrent identical insert (sync)
        }
        throw new MoldPlanError('MODEL', `conflicting mold insert: ${change.mold.id}`);
      }
      state.molds.set(change.mold.id, {
        id: change.mold.id,
        life: change.mold.life,
        changeTime: change.mold.changeTime,
        locked: false,
      });
      return { type: 'removeMold', moldId: change.mold.id };
    }
    case 'addShift': {
      const dup = state.calendar.shifts.find(
        (s) => s.id === change.shift.id && s.budget === change.shift.budget
      );
      if (dup) return { type: 'noop' }; // concurrent identical insert (sync)
      state.calendar.shifts.push({ id: change.shift.id, budget: change.shift.budget });
      state.shiftLoad.push(0);
      return { type: 'removeShift', shiftIdx: state.calendar.shifts.length - 1 };
    }
    case 'removeShift': {
      const idx = change.shiftIdx ?? state.calendar.shifts.length - 1;
      const [removed] = state.calendar.shifts.splice(idx, 1);
      state.shiftLoad.splice(idx, 1);
      return { type: 'addShift', shift: removed };
    }
    case 'removeMold': {
      const mold = requireMold(state, change.moldId);
      for (const [, a] of state.assignment) {
        if (a.mold === change.moldId) {
          throw new MoldPlanError('MODEL', `cannot remove mold in use: ${change.moldId}`);
        }
      }
      state.molds.delete(change.moldId);
      return { type: 'addMold', mold: { ...mold } };
    }
    case 'assign': {
      const job = requireJob(state, change.jobId);
      requireMold(state, change.mold);
      requireShift(state, change.shift);
      const prev = state.assignment.get(change.jobId);
      if (prev) {
        if (prev.shift === change.shift && prev.mold === change.mold) {
          return { type: 'noop' }; // concurrent identical assign (sync)
        }
        // deterministic conflict resolution: version-vector order decides
        // application order, later change wins
        state.assignment.set(change.jobId, { shift: change.shift, mold: change.mold });
        return { type: 'assign', jobId: change.jobId, shift: prev.shift, mold: prev.mold };
      }
      if (!job.eligible.includes(change.mold)) {
        throw new MoldPlanError('MODEL', `mold ${change.mold} not eligible for job ${change.jobId}`);
      }
      state.assignment.set(change.jobId, { shift: change.shift, mold: change.mold });
      return { type: 'unassign', jobId: change.jobId };
    }
    case 'unassign': {
      requireJob(state, change.jobId);
      const cur = state.assignment.get(change.jobId);
      if (!cur) throw new MoldPlanError('MODEL', `job not assigned: ${change.jobId}`);
      state.assignment.delete(change.jobId);
      return { type: 'assign', jobId: change.jobId, shift: cur.shift, mold: cur.mold };
    }
    default:
      throw new MoldPlanError('MODEL', `unknown change type: ${change.type}`);
  }
}

export function applyInverse(state, inverse) {
  // Inverses are themselves ordinary changes (assign/unassign/add/remove...).
  return applyChange(state, inverse);
}

// ---- batches -------------------------------------------------------------

export function beginBatch(state, lockedMolds = []) {
  for (const m of lockedMolds) requireMold(state, m);
  const batch = {
    id: `B${state.nextBatchSeq}`,
    seq: state.nextBatchSeq,
    changes: [],
    lockedMolds: [...lockedMolds].sort(),
  };
  state.nextBatchSeq += 1;
  state.batches.push(batch);
  return batch;
}

export function recordChange(state, batch, change) {
  const inverse = applyChange(state, change);
  batch.changes.push({ seq: state.nextChangeSeq, ...change, inverse });
  state.nextChangeSeq += 1;
  return inverse;
}

// Hierarchical rollback of the most recent batch.
// Changes touching a mold whose maintenance is locked by this batch are kept;
// if any change is skipped for that reason the batch is not fully rolled back
// and a ROLLBACK error is raised (out-of-bounds rollback).
export function rollbackLastBatch(state) {
  const batch = state.batches[state.batches.length - 1];
  if (!batch) {
    throw new MoldPlanError('ROLLBACK', 'no batch to roll back');
  }
  const locked = new Set(batch.lockedMolds);
  const kept = [];
  const skipped = [];
  for (let i = batch.changes.length - 1; i >= 0; i--) {
    const ch = batch.changes[i];
    const touchesLocked = locked.has(ch.mold) || (ch.inverse && locked.has(ch.inverse.mold));
    if (touchesLocked) {
      skipped.push(ch);
      kept.push(ch);
      continue;
    }
    applyInverse(state, ch.inverse);
  }
  batch.changes = kept;
  if (skipped.length > 0) {
    throw new MoldPlanError(
      'ROLLBACK',
      `batch ${batch.id} touches locked mold maintenance; rollback out of bounds`,
      { batch: batch.id, skipped: skipped.map((c) => c.seq) }
    );
  }
  state.batches.pop();
  return batch;
}

// ---- incremental derived state -------------------------------------------
// Only the jobs named in `dirtyJobIds` are re-applied to the aggregates.

export function recomputeIncremental(state, dirtyJobIds) {
  while (state.shiftLoad.length < state.calendar.shifts.length) state.shiftLoad.push(0);
  for (const jobId of dirtyJobIds) {
    const prev = state._lastApplied?.get(jobId);
    if (prev) {
      state.usage.set(prev.mold, (state.usage.get(prev.mold) ?? 0) - prev.units);
      if (state.usage.get(prev.mold) === 0) state.usage.delete(prev.mold);
      state.shiftLoad[prev.shift] -= prev.units;
      const set = state.moldShifts.get(prev.mold);
      if (set) {
        // recompute whether mold still used on that shift
        let still = false;
        for (const [otherJob, a] of state.assignment) {
          if (otherJob !== jobId && a.mold === prev.mold && a.shift === prev.shift) {
            still = true;
            break;
          }
        }
        if (!still) set.delete(prev.shift);
        if (set.size === 0) state.moldShifts.delete(prev.mold);
      }
    }
    const cur = state.assignment.get(jobId);
    if (cur) {
      const job = state.jobs.get(jobId);
      if (job) {
        state.usage.set(cur.mold, (state.usage.get(cur.mold) ?? 0) + job.units);
        state.shiftLoad[cur.shift] += job.units;
        if (!state.moldShifts.has(cur.mold)) state.moldShifts.set(cur.mold, new Set());
        state.moldShifts.get(cur.mold).add(cur.shift);
        if (!state._lastApplied) state._lastApplied = new Map();
        state._lastApplied.set(jobId, { mold: cur.mold, shift: cur.shift, units: job.units });
      }
    } else if (state._lastApplied) {
      state._lastApplied.delete(jobId);
    }
  }
  finalizeDerived(state);
}

// Full recompute — used only at load/recovery time, never per-change.
export function recomputeFull(state) {
  state.usage = new Map();
  state.shiftLoad = state.calendar.shifts.map(() => 0);
  state.moldShifts = new Map();
  state._lastApplied = new Map();
  for (const [jobId, a] of state.assignment) {
    const job = state.jobs.get(jobId);
    if (!job) continue;
    state.usage.set(a.mold, (state.usage.get(a.mold) ?? 0) + job.units);
    state.shiftLoad[a.shift] += job.units;
    if (!state.moldShifts.has(a.mold)) state.moldShifts.set(a.mold, new Set());
    state.moldShifts.get(a.mold).add(a.shift);
    state._lastApplied.set(jobId, { mold: a.mold, shift: a.shift, units: job.units });
  }
  finalizeDerived(state);
}

function finalizeDerived(state) {
  // pending: mold over-allocation (never silently unsatisfiable)
  state.pending = [];
  for (const [moldId, used] of [...state.usage].sort()) {
    const mold = state.molds.get(moldId);
    if (mold && used > mold.life) {
      state.pending.push({ mold: moldId, used, life: mold.life });
    }
  }
  // feasibility: every job assigned, budgets respected, no pending
  let feasible = state.pending.length === 0;
  if (feasible) {
    for (const jobId of state.jobs.keys()) {
      if (!state.assignment.has(jobId)) {
        feasible = false;
        break;
      }
    }
  }
  if (feasible) {
    for (let i = 0; i < state.calendar.shifts.length; i++) {
      if (state.shiftLoad[i] > state.calendar.shifts[i].budget) {
        feasible = false;
        break;
      }
    }
  }
  state.feasible = feasible;
  if (feasible) {
    state.certificate = makeCertificate(state);
  }
}

export function makeCertificate(state) {
  const assignment = [...state.assignment]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([jobId, a]) => ({ job: jobId, shift: a.shift, mold: a.mold }));
  const shiftsUsed = new Set(assignment.map((a) => a.shift)).size;
  let setupTime = 0;
  const perShiftMolds = new Map();
  for (const a of assignment) {
    if (!perShiftMolds.has(a.shift)) perShiftMolds.set(a.shift, new Set());
    perShiftMolds.get(a.shift).add(a.mold);
  }
  for (const molds of perShiftMolds.values()) {
    for (const m of molds) setupTime += state.molds.get(m).changeTime;
  }
  return {
    cost: [shiftsUsed, setupTime],
    assignment,
    shiftLoad: [...state.shiftLoad],
    usage: Object.fromEntries([...state.usage].sort()),
  };
}

// ---- serialization ---------------------------------------------------------

export function stateToJSON(s) {
  return {
    jobs: [...s.jobs.values()].map((j) => ({ ...j, eligible: [...j.eligible] })),
    molds: [...s.molds.values()].map((m) => ({ ...m })),
    calendar: { shifts: s.calendar.shifts.map((x) => ({ ...x })) },
    assignment: [...s.assignment].map(([job, a]) => ({ job, ...a })),
    batches: s.batches.map((b) => ({
      id: b.id,
      seq: b.seq,
      origin: b.origin ?? null,
      lockedMolds: [...b.lockedMolds],
      changes: b.changes.map((c) => ({ ...c, inverse: { ...c.inverse } })),
    })),
    nextBatchSeq: s.nextBatchSeq,
    nextChangeSeq: s.nextChangeSeq,
    certificate: s.certificate,
  };
}

export function stateFromJSON(doc) {
  const s = emptyState();
  for (const m of doc.molds ?? []) s.molds.set(m.id, { ...m });
  for (const j of doc.jobs ?? []) s.jobs.set(j.id, { ...j, eligible: [...j.eligible].sort() });
  s.calendar = { shifts: (doc.calendar?.shifts ?? []).map((x) => ({ ...x })) };
  for (const a of doc.assignment ?? []) s.assignment.set(a.job, { shift: a.shift, mold: a.mold });
  s.batches = (doc.batches ?? []).map((b) => ({
    ...b,
    origin: b.origin ?? null,
    lockedMolds: [...b.lockedMolds],
    changes: b.changes.map((c) => ({ ...c, inverse: { ...c.inverse } })),
  }));
  s.nextBatchSeq = doc.nextBatchSeq ?? 1;
  s.nextChangeSeq = doc.nextChangeSeq ?? 1;
  s.certificate = doc.certificate ?? null;
  recomputeFull(s);
  return s;
}
