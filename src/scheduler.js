// Core deterministic scheduler: constraint scheduling with per-institution
// quotas, global fairness, starvation aging, and priority preemption with
// atomic rollback. Every mutation emits a replayable certificate.
import { emitCertificate } from './certificates.js';

export const SCORE_BASE = 1000000;

export function quotaOf(config, institution) {
  return config.quotas.has(institution) ? config.quotas.get(institution) : Infinity;
}

// Aging: an instruction that arrived earlier has waited longer and earns an
// aging bonus, so long-waiting low-priority instructions are not starved by
// freshly arriving higher-priority ones.
export function scoreOf(config, instr) {
  const age = config.slots - instr.arrivalSlot;
  return instr.priority * SCORE_BASE + age * config.agingRate;
}

export function createState(config, instructions, excluded) {
  const byId = new Map(instructions.map((i) => [i.id, i]));
  const dependents = new Map(instructions.map((i) => [i.id, []]));
  for (const instr of instructions) {
    for (const dep of instr.dependencies) {
      if (dependents.has(dep)) dependents.get(dep).push(instr.id);
    }
  }
  for (const list of dependents.values()) list.sort();
  return {
    config,
    instructions,
    byId,
    dependents,
    excluded: new Set(excluded),
    status: new Map(instructions.map((i) => [i.id, 'pending'])),
    slotOf: new Map(),
    occupancy: new Map(),
    usage: new Map(),
    certificates: [],
    errors: [],
    seq: 0,
    ancestorMemo: new Map(),
  };
}

function loadOf(state, slot) {
  const occ = state.occupancy.get(slot);
  return occ ? occ.length : 0;
}

function usageOf(state, institution) {
  return state.usage.get(institution) ?? 0;
}

function fairnessRatio(state, institution) {
  const quota = quotaOf(state.config, institution);
  if (quota === Infinity) return 0;
  if (quota === 0) return Infinity;
  return usageOf(state, institution) / quota;
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Total deterministic candidate ordering:
//   1. effective score (priority + aging bonus), descending
//   2. global fairness: institution quota-usage ratio, ascending
//   3. amount, descending
//   4. deadline slot, ascending
//   5. id, lexicographic
export function compareCandidates(state, idA, idB) {
  const a = state.byId.get(idA);
  const b = state.byId.get(idB);
  const sa = scoreOf(state.config, a);
  const sb = scoreOf(state.config, b);
  if (sa !== sb) return sb - sa;
  const ra = fairnessRatio(state, a.institution);
  const rb = fairnessRatio(state, b.institution);
  if (ra !== rb) return ra - rb;
  if (a.amount !== b.amount) return b.amount - a.amount;
  if (a.deadlineSlot !== b.deadlineSlot) return a.deadlineSlot - b.deadlineSlot;
  return compareIds(a.id, b.id);
}

// Eviction ordering inside a slot: lowest priority, then lowest amount, then id.
function compareEviction(state, idA, idB) {
  const a = state.byId.get(idA);
  const b = state.byId.get(idB);
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.amount !== b.amount) return a.amount - b.amount;
  return compareIds(a.id, b.id);
}

export function ancestorsOf(state, id) {
  if (state.ancestorMemo.has(id)) return state.ancestorMemo.get(id);
  const result = new Set();
  const stack = [...state.byId.get(id).dependencies];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (result.has(cur)) continue;
    result.add(cur);
    const instr = state.byId.get(cur);
    if (instr) for (const d of instr.dependencies) stack.push(d);
  }
  state.ancestorMemo.set(id, result);
  return result;
}

function depsConfirmed(state, id) {
  for (const dep of state.byId.get(id).dependencies) {
    if (!state.slotOf.has(dep)) return false;
  }
  return true;
}

// Confirmed transitive dependents of `id`, sorted by id (deterministic).
export function confirmedTransitiveDependents(state, id) {
  const result = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of state.dependents.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      if (state.slotOf.has(next)) result.push(next);
    }
  }
  return result.sort();
}

function place(state, id, slot, reason, detail = {}) {
  state.slotOf.set(id, slot);
  if (!state.occupancy.has(slot)) state.occupancy.set(slot, []);
  state.occupancy.get(slot).push(id);
  const inst = state.byId.get(id).institution;
  state.usage.set(inst, usageOf(state, inst) + 1);
  state.status.set(id, 'confirmed');
  emitCertificate(state, { op: 'assign', instructionId: id, slot, reason, ...detail });
}

function removeAssignment(state, id, op, reason, status, detail = {}) {
  const slot = state.slotOf.get(id);
  state.slotOf.delete(id);
  const occ = state.occupancy.get(slot);
  occ.splice(occ.indexOf(id), 1);
  const inst = state.byId.get(id).institution;
  state.usage.set(inst, usageOf(state, inst) - 1);
  state.status.set(id, status);
  emitCertificate(state, { op, instructionId: id, slot, reason, ...detail });
}

// Attempts to place instruction `id`. With allowPreempt, a strictly higher
// priority instruction may evict a lower-priority occupant; the victim (and
// its confirmed transitive dependents) is rolled back atomically: the whole
// eviction+placement either commits with certificates or does not happen.
export function tryPlace(state, id, { allowPreempt, reason }) {
  const instr = state.byId.get(id);
  let maxDepSlot = 0;
  for (const dep of instr.dependencies) {
    const s = state.slotOf.get(dep);
    if (s === undefined) return false;
    if (s > maxDepSlot) maxDepSlot = s;
  }
  const lo = Math.max(instr.arrivalSlot, maxDepSlot + 1);
  if (lo > instr.deadlineSlot) return false;
  const inst = instr.institution;
  const quota = quotaOf(state.config, inst);
  const used = usageOf(state, inst);
  const cap = state.config.capacityPerSlot;

  for (let s = lo; s <= instr.deadlineSlot; s++) {
    if (loadOf(state, s) < cap && used < quota) {
      place(state, id, s, reason);
      return true;
    }
  }
  if (!allowPreempt) return false;

  const ancestors = ancestorsOf(state, id);
  for (let s = lo; s <= instr.deadlineSlot; s++) {
    const occ = state.occupancy.get(s);
    if (!occ || occ.length === 0) continue;
    const candidates = [...occ].sort((a, b) => compareEviction(state, a, b));
    for (const victim of candidates) {
      const victimInstr = state.byId.get(victim);
      if (victimInstr.priority >= instr.priority) continue;
      if (ancestors.has(victim)) continue; // never evict our own ancestor
      const cascade = confirmedTransitiveDependents(state, victim);
      let removedForInst = victimInstr.institution === inst ? 1 : 0;
      for (const v of cascade) {
        if (state.byId.get(v).institution === inst) removedForInst++;
      }
      if (used - removedForInst + 1 > quota) continue;
      // Commit the atomic rollback + placement.
      for (const v of cascade) {
        removeAssignment(state, v, 'rollback', 'cascade', 'pending', { cause: victim });
      }
      removeAssignment(state, victim, 'preempt', 'preempted', 'pending', { by: id });
      place(state, id, s, 'preempt');
      return true;
    }
  }
  return false;
}

// Initial scheduling: repeatedly pick the best ready candidate (dynamic
// fairness ratios) and place it, with preemption. Terminates because every
// iteration either confirms one instruction or stops.
export function scheduleInitial(state) {
  const n = state.instructions.length;
  const maxEvents = 1000 + 100 * n * n;
  let events = 0;
  for (;;) {
    const ready = [];
    for (const instr of state.instructions) {
      if (state.status.get(instr.id) !== 'pending') continue;
      if (state.excluded.has(instr.id)) continue;
      if (depsConfirmed(state, instr.id)) ready.push(instr.id);
    }
    if (ready.length === 0) break;
    ready.sort((a, b) => compareCandidates(state, a, b));
    let placed = false;
    for (const id of ready) {
      if (tryPlace(state, id, { allowPreempt: true, reason: 'initial' })) {
        placed = true;
        break;
      }
    }
    if (!placed) break;
    events += 1;
    if (events > maxEvents) {
      state.errors.push({ code: 'INTERNAL_LIMIT', message: 'scheduling event limit exceeded' });
      break;
    }
  }
}

// Incremental repair: after quota/capacity is released (e.g. by an undo),
// greedily fill freed slots with currently unscheduled instructions whose
// dependencies are confirmed. Existing confirmed assignments are never
// recomputed and no new preemptions are triggered.
export function repair(state) {
  for (;;) {
    const candidates = [];
    for (const instr of state.instructions) {
      if (state.status.get(instr.id) !== 'unscheduled') continue;
      if (state.excluded.has(instr.id)) continue;
      if (depsConfirmed(state, instr.id)) candidates.push(instr.id);
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => compareCandidates(state, a, b));
    let placed = false;
    for (const id of candidates) {
      if (tryPlace(state, id, { allowPreempt: false, reason: 'repair' })) {
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }
}

// Transitions leftover pending instructions to unscheduled. Called after the
// initial scheduling phase and defensively in buildOutput.
export function settle(state) {
  for (const instr of state.instructions) {
    if (state.status.get(instr.id) === 'pending') state.status.set(instr.id, 'unscheduled');
  }
}

// Undoes one confirmed instruction. Dependent confirmed instructions are
// cascade-marked as orphans and their quota is released; freed capacity is
// then repaired incrementally. Undoing anything that is not currently
// confirmed is a STALE_UNDO error.
export function undoInstruction(state, id) {
  const instr = state.byId.get(id);
  if (!instr || state.status.get(id) !== 'confirmed') {
    state.errors.push({
      code: 'STALE_UNDO',
      message: `instruction ${id} is not currently confirmed and cannot be undone`,
      instructionId: id,
    });
    return false;
  }
  const orphans = confirmedTransitiveDependents(state, id);
  removeAssignment(state, id, 'undo', 'undo', 'revoked');
  for (const orphan of orphans) {
    removeAssignment(state, orphan, 'orphan', 'dependency-revoked', 'orphan', { cause: id });
  }
  repair(state);
  return true;
}

function classifyUnscheduled(state, instr) {
  for (const dep of instr.dependencies) {
    if (!state.slotOf.has(dep)) return 'DEP_UNMET';
  }
  if (usageOf(state, instr.institution) >= quotaOf(state.config, instr.institution)) {
    return 'QUOTA';
  }
  return 'CAPACITY';
}

const STATUS_ORDER = { confirmed: 0, unscheduled: 1, orphan: 2, revoked: 3 };

export function buildOutput(state) {
  settle(state);
  const schedErrors = [];
  for (const instr of state.instructions) {
    if (state.status.get(instr.id) !== 'unscheduled') continue;
    if (state.excluded.has(instr.id)) continue; // already reported as CYCLE / MISSING_DEP
    const code = classifyUnscheduled(state, instr);
    schedErrors.push({
      code,
      message: `instruction ${instr.id} could not be scheduled (${code.toLowerCase()})`,
      instructionId: instr.id,
    });
  }
  schedErrors.sort((a, b) => compareIds(a.instructionId, b.instructionId));

  const schedule = state.instructions
    .map((instr) => ({
      id: instr.id,
      institution: instr.institution,
      status: state.status.get(instr.id),
      slot: state.slotOf.get(instr.id) ?? null,
      amount: instr.amount,
      priority: instr.priority,
      deadlineSlot: instr.deadlineSlot,
    }))
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.status];
      const sb = STATUS_ORDER[b.status];
      if (sa !== sb) return sa - sb;
      if (a.status === 'confirmed' && a.slot !== b.slot) return a.slot - b.slot;
      return compareIds(a.id, b.id);
    });

  return {
    schedule,
    certificates: state.certificates,
    errors: [...state.errors, ...schedErrors],
  };
}
