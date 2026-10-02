import { UsageError, parseOperation } from './model.js';

export const DEFAULT_BUDGET = 200000;

export function tardinessOf(op, start) {
  return Math.max(0, start + op.duration - op.due);
}

/**
 * Mutable propagation state. Every placement is recorded on a trail so it can
 * be rolled back hierarchically (slot occupancy, cumulative tool load and
 * fixture occupancy are all reversed through the same trail entries).
 */
export class State {
  constructor(instance) {
    this.instance = instance;
    this.toolLife = new Map(instance.tools.map((t) => [t.id, t.life]));
    this.machineOcc = new Map(instance.machines.map((m) => [m, new Uint8Array(instance.horizon)]));
    this.fixtureOcc = new Map(instance.fixtures.map((f) => [f, new Uint8Array(instance.horizon)]));
    this.toolLoad = new Map(instance.tools.map((t) => [t.id, 0]));
    this.assignments = new Map();
    this.trail = [];
  }

  check(op, machine, tool, start) {
    const end = start + op.duration;
    if (start < 0 || end > this.instance.horizon) {
      return { type: 'horizon', op: op.id, start, end, horizon: this.instance.horizon };
    }
    const occ = this.machineOcc.get(machine);
    for (let i = start; i < end; i += 1) {
      if (occ[i]) return { type: 'machine-overlap', op: op.id, machine, slot: i };
    }
    if (op.fixture) {
      const focc = this.fixtureOcc.get(op.fixture);
      for (let i = start; i < end; i += 1) {
        if (focc[i]) return { type: 'fixture-conflict', op: op.id, fixture: op.fixture, slot: i };
      }
    }
    const load = this.toolLoad.get(tool);
    const life = this.toolLife.get(tool);
    if (load + op.minutes > life) {
      return { type: 'tool-life', op: op.id, tool, currentLoad: load, addedMinutes: op.minutes, life };
    }
    return null;
  }

  applyEntry(entry) {
    const { op, machine, tool, start } = entry;
    const occ = this.machineOcc.get(machine);
    for (let i = start; i < start + op.duration; i += 1) occ[i] += 1;
    if (op.fixture) {
      const focc = this.fixtureOcc.get(op.fixture);
      for (let i = start; i < start + op.duration; i += 1) focc[i] += 1;
    }
    this.toolLoad.set(tool, this.toolLoad.get(tool) + op.minutes);
    this.assignments.set(op.id, { machine, tool, start });
  }

  reverseEntry(entry) {
    const { op, machine, tool, start } = entry;
    const occ = this.machineOcc.get(machine);
    for (let i = start; i < start + op.duration; i += 1) occ[i] -= 1;
    if (op.fixture) {
      const focc = this.fixtureOcc.get(op.fixture);
      for (let i = start; i < start + op.duration; i += 1) focc[i] -= 1;
    }
    this.toolLoad.set(tool, this.toolLoad.get(tool) - op.minutes);
    this.assignments.delete(op.id);
  }

  place(op, machine, tool, start) {
    const entry = { op, machine, tool, start };
    this.applyEntry(entry);
    this.trail.push(entry);
  }

  undo() {
    const entry = this.trail.pop();
    if (entry) this.reverseEntry(entry);
  }

  checkpoint() {
    return this.trail.length;
  }

  rollback(cp) {
    while (this.trail.length > cp) {
      this.reverseEntry(this.trail.pop());
    }
  }

  /**
   * Hierarchical rollback of one committed operation: undo every propagation
   * entry recorded after it, undo the operation's own slot/tool/fixture
   * effects, then re-apply the later entries. Other assignments are kept.
   */
  unassign(opId) {
    const idx = this.trail.findIndex((e) => e.op.id === opId);
    if (idx === -1) return false;
    const above = this.trail.splice(idx + 1);
    for (let i = above.length - 1; i >= 0; i -= 1) this.reverseEntry(above[i]);
    const entry = this.trail.pop();
    this.reverseEntry(entry);
    for (const e of above) {
      this.applyEntry(e);
      this.trail.push(e);
    }
    return true;
  }
}

function candidateStarts(instance, op) {
  const starts = [];
  for (let s = 0; s + op.duration <= instance.horizon; s += 1) starts.push(s);
  starts.sort((a, b) => tardinessOf(op, a) - tardinessOf(op, b) || a - b);
  return starts;
}

/**
 * Propagation: cumulative tool-life bound and fixture/machine mutex are
 * forward-checked for every still-unassigned operation. Returns null when the
 * partial state is consistent, otherwise a failure witness.
 */
function forwardCheck(state, ops, fromIdx) {
  for (const tool of state.instance.tools) {
    const remaining = tool.life - state.toolLoad.get(tool.id);
    let mandatory = 0;
    for (let i = fromIdx; i < ops.length; i += 1) {
      const op = ops[i];
      if (op.tools.length === 1 && op.tools[0] === tool.id) mandatory += op.minutes;
    }
    if (mandatory > remaining) {
      return {
        type: 'tool-life',
        tool: tool.id,
        remainingLife: remaining,
        mandatoryMinutes: mandatory,
      };
    }
  }
  for (let i = fromIdx; i < ops.length; i += 1) {
    const op = ops[i];
    let feasible = false;
    outer: for (const s of candidateStarts(state.instance, op)) {
      for (const m of op.machines) {
        for (const t of op.tools) {
          if (!state.check(op, m, t, s)) { feasible = true; break outer; }
        }
      }
    }
    if (!feasible) return { type: 'domain-wipeout', op: op.id };
  }
  return null;
}

export function buildProof(instance, failure) {
  for (const tool of instance.tools) {
    const forced = instance.operations.filter(
      (o) => o.tools.length === 1 && o.tools[0] === tool.id
    );
    const required = forced.reduce((acc, o) => acc + o.minutes, 0);
    if (required > tool.life) {
      return {
        type: 'tool-life',
        tool: tool.id,
        requiredMinutes: required,
        life: tool.life,
        operations: forced.map((o) => o.id),
      };
    }
  }
  for (const f of instance.fixtures) {
    const users = instance.operations.filter((o) => o.fixture === f);
    const requiredSlots = users.reduce((acc, o) => acc + o.duration, 0);
    if (requiredSlots > instance.horizon) {
      return {
        type: 'fixture-capacity',
        fixture: f,
        requiredSlots,
        horizon: instance.horizon,
        operations: users.map((o) => o.id),
      };
    }
  }
  for (const m of instance.machines) {
    const forced = instance.operations.filter(
      (o) => o.machines.length === 1 && o.machines[0] === m
    );
    const requiredSlots = forced.reduce((acc, o) => acc + o.duration, 0);
    if (requiredSlots > instance.horizon) {
      return {
        type: 'machine-capacity',
        machine: m,
        requiredSlots,
        horizon: instance.horizon,
        operations: forced.map((o) => o.id),
      };
    }
  }
  return { type: 'search-conflict', ...(failure ?? {}) };
}

export function solve(instance, { budget = DEFAULT_BUDGET } = {}) {
  const state = new State(instance);
  const ops = [...instance.operations].sort(
    (a, b) =>
      a.machines.length * a.tools.length - b.machines.length * b.tools.length ||
      b.minutes - a.minutes
  );
  const startsCache = new Map(ops.map((op) => [op.id, candidateStarts(instance, op)]));

  let best = Infinity;
  let bestAssignments = null;
  let nodes = 0;
  let exhausted = false;
  let deepest = -1;
  let failure = null;

  const recordFailure = (idx, reason) => {
    if (idx >= deepest) {
      deepest = idx;
      failure = reason;
    }
  };

  const initialFailure = forwardCheck(state, ops, 0);
  if (initialFailure) {
    return { status: 'infeasible', proof: buildProof(instance, initialFailure), nodes: 0 };
  }

  function search(idx, accTardiness) {
    if (exhausted) return;
    if (accTardiness >= best) return;
    if (idx === ops.length) {
      best = accTardiness;
      bestAssignments = new Map(state.assignments);
      return;
    }
    const op = ops[idx];
    let anyPlaced = false;
    for (const s of startsCache.get(op.id)) {
      const t = tardinessOf(op, s);
      if (accTardiness + t >= best) break;
      for (const m of op.machines) {
        for (const tool of op.tools) {
          nodes += 1;
          if (nodes > budget) {
            exhausted = true;
            return;
          }
          const reason = state.check(op, m, tool, s);
          if (reason) {
            recordFailure(idx, reason);
            continue;
          }
          state.place(op, m, tool, s);
          const propagated = forwardCheck(state, ops, idx + 1);
          if (propagated) {
            recordFailure(idx + 1, propagated);
          } else {
            anyPlaced = true;
            search(idx + 1, accTardiness + t);
          }
          state.undo();
          if (exhausted) return;
        }
      }
    }
    if (!anyPlaced) recordFailure(idx, { type: 'no-feasible-value', op: op.id });
  }

  search(0, 0);

  if (bestAssignments) {
    const assignments = {};
    for (const op of instance.operations) {
      assignments[op.id] = bestAssignments.get(op.id);
    }
    return { status: 'optimal', tardiness: best, assignments, nodes };
  }
  if (exhausted) {
    return {
      status: 'unknown',
      pending: {
        nodesExplored: budget,
        budget,
        totalOps: ops.length,
        resolvedOps: Math.max(0, deepest),
        unresolvedOps: ops.length - Math.max(0, deepest),
      },
      nodes,
    };
  }
  return { status: 'infeasible', proof: buildProof(instance, failure), nodes };
}

function solveSingleOp(state, instance, op, budget) {
  let best = Infinity;
  let bestValue = null;
  let nodes = 0;
  const reasons = [];
  for (const s of candidateStarts(instance, op)) {
    const t = tardinessOf(op, s);
    if (t >= best) break;
    for (const m of op.machines) {
      for (const tool of op.tools) {
        nodes += 1;
        if (nodes > budget) {
          return { status: 'unknown', pending: { nodesExplored: nodes, budget } };
        }
        const reason = state.check(op, m, tool, s);
        if (reason) {
          reasons.push(reason);
          continue;
        }
        best = t;
        bestValue = { machine: m, tool, start: s };
      }
    }
  }
  if (bestValue) return { status: 'optimal', assignment: bestValue, tardiness: best, nodes };
  const toolFailures = reasons.filter((r) => r.type === 'tool-life');
  const fixtureFailures = reasons.filter((r) => r.type === 'fixture-conflict');
  let proof;
  if (toolFailures.length > 0 && toolFailures.length >= reasons.length) {
    const byTool = new Map();
    for (const r of toolFailures) byTool.set(r.tool, r);
    proof = {
      type: 'tool-life',
      op: op.id,
      tools: [...byTool.values()].map((r) => ({
        tool: r.tool,
        currentLoad: r.currentLoad,
        addedMinutes: r.addedMinutes,
        life: r.life,
      })),
    };
  } else if (fixtureFailures.length > 0) {
    proof = { type: 'fixture-conflict', op: op.id, fixture: op.fixture, slot: fixtureFailures[0].slot };
  } else {
    proof = { type: 'search-conflict', op: op.id, reasons: reasons.slice(0, 5) };
  }
  return { status: 'infeasible', proof, nodes };
}

/**
 * Replace one committed operation with a new operation. The old operation's
 * slot/tool/fixture propagation is rolled back hierarchically; every other
 * committed assignment is preserved. The new operation is then added
 * incrementally on top of the remaining committed state.
 */
export function replaceOperation(instance, committedAssignments, opId, newOpRaw, { budget = DEFAULT_BUDGET } = {}) {
  const oldOp = instance.operations.find((o) => o.id === opId);
  if (!oldOp) throw new UsageError(`unknown operation "${opId}"`);
  const ctx = {
    machines: instance.machines,
    toolIds: new Set(instance.tools.map((t) => t.id)),
    fixtures: instance.fixtures,
    slotMinutes: instance.slotMinutes,
    dueSlot: instance.dueSlot,
  };
  const newOp = parseOperation(newOpRaw, ctx);
  if (newOp.id !== opId && instance.operations.some((o) => o.id === newOp.id)) {
    throw new UsageError(`duplicate operation id "${newOp.id}"`);
  }

  const committed =
    committedAssignments instanceof Map
      ? committedAssignments
      : new Map(Object.entries(committedAssignments));

  const state = new State(instance);
  for (const op of instance.operations) {
    const a = committed.get(op.id);
    if (!a) throw new UsageError(`missing committed assignment for operation "${op.id}"`);
    const reason = state.check(op, a.machine, a.tool, a.start);
    if (reason) {
      throw new UsageError(
        `committed assignment for "${op.id}" is inconsistent: ${JSON.stringify(reason)}`
      );
    }
    state.place(op, a.machine, a.tool, a.start);
  }

  // Hierarchical rollback of everything the replaced operation triggered.
  state.unassign(opId);

  const kept = instance.operations.filter((o) => o.id !== opId);
  const newInstance = { ...instance, operations: [...kept, newOp] };

  const result = solveSingleOp(state, newInstance, newOp, budget);
  if (result.status !== 'optimal') return { ...result, opId, newOp: newOp.id };

  state.place(newOp, result.assignment.machine, result.assignment.tool, result.assignment.start);

  const assignments = {};
  let totalTardiness = 0;
  for (const op of kept) {
    assignments[op.id] = state.assignments.get(op.id);
    const a = state.assignments.get(op.id);
    totalTardiness += tardinessOf(op, a.start);
  }
  assignments[newOp.id] = result.assignment;
  totalTardiness += tardinessOf(newOp, result.assignment.start);

  const toolLoad = {};
  for (const [tool, load] of state.toolLoad) toolLoad[tool] = load;

  return {
    status: 'optimal',
    opId,
    newOp: newOp.id,
    rolledBack: oldOp.id,
    tardiness: totalTardiness,
    assignments,
    toolLoad,
    nodes: result.nodes,
  };
}
