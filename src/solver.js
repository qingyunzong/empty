import { ValidationError, normalizeOp, validateAssignmentValue } from './problem.js';

function tardinessOf(op, slot) {
  return Math.max(0, slot - op.due);
}

export class Solver {
  constructor(problem, { budget = 100000 } = {}) {
    this.problem = problem;
    this.budget = budget;
    this.nodes = 0;
    this.aborted = false;
    this.pendingAtAbort = null;

    this.assignment = new Map();
    this.machineBusy = new Map(problem.machines.map((m) => [m, new Map()]));
    this.fixtureBusy = new Map(problem.fixtures.map((f) => [f, new Map()]));
    this.toolLoad = new Map(Object.keys(problem.tools).map((t) => [t, 0]));

    this.trail = [];
    this.levelByOp = new Map();
    this.nextLevel = 0;

    this.conflicts = [];
    this.conflictKeys = new Set();
    this.best = null;
  }

  toolRemaining(tool) {
    return this.problem.tools[tool].life - this.toolLoad.get(tool);
  }

  valueOk(op, machine, slot, tool) {
    if (this.machineBusy.get(machine).has(slot)) return false;
    if (op.fixture !== null && this.fixtureBusy.get(op.fixture).has(slot)) return false;
    if (this.toolRemaining(tool) < op.cut) return false;
    return true;
  }

  feasibleValues(op) {
    const values = [];
    for (const machine of op.machines) {
      for (let slot = 0; slot < this.problem.slots; slot++) {
        for (const tool of op.tools) {
          if (this.valueOk(op, machine, slot, tool)) values.push({ machine, slot, tool });
        }
      }
    }
    values.sort(
      (a, b) =>
        tardinessOf(op, a.slot) - tardinessOf(op, b.slot) ||
        a.slot - b.slot ||
        a.machine.localeCompare(b.machine) ||
        a.tool.localeCompare(b.tool),
    );
    return values;
  }

  apply(op, value, level) {
    this.assignment.set(op.id, value);
    this.levelByOp.set(op.id, level);
    this.trail.push({ level, kind: 'assign', opId: op.id });
    this.machineBusy.get(value.machine).set(value.slot, op.id);
    this.trail.push({ level, kind: 'machine', machine: value.machine, slot: value.slot });
    if (op.fixture !== null) {
      this.fixtureBusy.get(op.fixture).set(value.slot, op.id);
      this.trail.push({ level, kind: 'fixture', fixture: op.fixture, slot: value.slot });
    }
    this.toolLoad.set(value.tool, this.toolLoad.get(value.tool) + op.cut);
    this.trail.push({ level, kind: 'tool', tool: value.tool, cut: op.cut });
  }

  revert(entry) {
    if (entry.kind === 'assign') {
      this.assignment.delete(entry.opId);
      this.levelByOp.delete(entry.opId);
    } else if (entry.kind === 'machine') {
      this.machineBusy.get(entry.machine).delete(entry.slot);
    } else if (entry.kind === 'fixture') {
      this.fixtureBusy.get(entry.fixture).delete(entry.slot);
    } else if (entry.kind === 'tool') {
      this.toolLoad.set(entry.tool, this.toolLoad.get(entry.tool) - entry.cut);
    }
  }

  undoLevel(level) {
    while (this.trail.length > 0 && this.trail[this.trail.length - 1].level === level) {
      this.revert(this.trail.pop());
    }
  }

  undoOpLayer(opId) {
    const level = this.levelByOp.get(opId);
    if (level === undefined) return false;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this.trail[i].level === level) {
        this.revert(this.trail[i]);
        this.trail.splice(i, 1);
      }
    }
    return true;
  }

  recordConflict(reasons) {
    for (const reason of reasons) {
      const key = JSON.stringify(reason);
      if (!this.conflictKeys.has(key)) {
        this.conflictKeys.add(key);
        this.conflicts.push(reason);
      }
    }
  }

  analyzeConflict(op) {
    const reasons = [];
    for (const tool of op.tools) {
      const remaining = this.toolRemaining(tool);
      if (remaining < op.cut) {
        reasons.push({
          type: 'tool-life',
          op: op.id,
          tool,
          required: op.cut,
          remaining,
          life: this.problem.tools[tool].life,
        });
      }
    }
    if (op.fixture !== null) {
      const busy = this.fixtureBusy.get(op.fixture);
      if (busy.size >= this.problem.slots) {
        reasons.push({
          type: 'fixture-mutex',
          op: op.id,
          fixture: op.fixture,
          slots: this.problem.slots,
          heldBy: [...busy.entries()].map(([slot, holder]) => ({ slot, op: holder })),
        });
      }
    }
    for (const machine of op.machines) {
      const busy = this.machineBusy.get(machine);
      if (busy.size >= this.problem.slots) {
        reasons.push({
          type: 'machine-capacity',
          op: op.id,
          machine,
          slots: this.problem.slots,
          heldBy: [...busy.entries()].map(([slot, holder]) => ({ slot, op: holder })),
        });
      }
    }
    if (reasons.length === 0) {
      reasons.push({ type: 'domain-wipeout', op: op.id });
    }
    return reasons;
  }

  quickInfeasible() {
    const { problem } = this;
    for (const [tool, def] of Object.entries(problem.tools)) {
      const forced = problem.ops.filter((o) => o.tools.length === 1 && o.tools[0] === tool);
      const required = forced.reduce((sum, o) => sum + o.cut, 0);
      if (required > def.life) {
        return {
          type: 'tool-life',
          tool,
          ops: forced.map((o) => o.id),
          required,
          life: def.life,
        };
      }
    }
    for (const fixture of problem.fixtures) {
      const users = problem.ops.filter((o) => o.fixture === fixture);
      if (users.length > problem.slots) {
        return {
          type: 'fixture-capacity',
          fixture,
          ops: users.map((o) => o.id),
          count: users.length,
          slots: problem.slots,
        };
      }
    }
    for (const machine of problem.machines) {
      const forced = problem.ops.filter((o) => o.machines.length === 1 && o.machines[0] === machine);
      if (forced.length > problem.slots) {
        return {
          type: 'machine-capacity',
          machine,
          ops: forced.map((o) => o.id),
          count: forced.length,
          slots: problem.slots,
        };
      }
    }
    return null;
  }

  dfs(unassigned, tardSoFar) {
    if (this.aborted) return;
    if (this.nodes >= this.budget) {
      this.aborted = true;
      this.pendingAtAbort = unassigned.map((o) => o.id);
      return;
    }
    if (unassigned.length === 0) {
      if (this.best === null || tardSoFar < this.best.tardiness) {
        this.best = {
          tardiness: tardSoFar,
          assignment: Object.fromEntries(this.assignment),
        };
      }
      return;
    }
    if (this.best !== null && tardSoFar >= this.best.tardiness) return;
    this.nodes++;

    let chosen = null;
    let chosenValues = null;
    for (const op of unassigned) {
      const values = this.feasibleValues(op);
      if (values.length === 0) {
        this.recordConflict(this.analyzeConflict(op));
        return;
      }
      if (chosenValues === null || values.length < chosenValues.length) {
        chosen = op;
        chosenValues = values;
        if (values.length === 1) break;
      }
    }

    const rest = unassigned.filter((o) => o !== chosen);
    const level = this.nextLevel++;
    for (const value of chosenValues) {
      this.apply(chosen, value, level);
      this.dfs(rest, tardSoFar + tardinessOf(chosen, value.slot));
      this.undoLevel(level);
      if (this.aborted) return;
    }
  }

  solve() {
    const quick = this.quickInfeasible();
    if (quick !== null) {
      return { status: 'infeasible', proof: quick, nodes: 0 };
    }
    this.dfs(this.problem.ops.slice(), 0);
    if (this.aborted) {
      return {
        status: 'unknown',
        pending: this.pendingAtAbort,
        incumbent: this.best,
        nodes: this.nodes,
      };
    }
    if (this.best !== null) {
      return {
        status: 'optimal',
        assignment: this.best.assignment,
        tardiness: this.best.tardiness,
        nodes: this.nodes,
      };
    }
    return {
      status: 'infeasible',
      proof: this.conflicts[0] ?? { type: 'unsatisfiable' },
      conflicts: this.conflicts.slice(0, 10),
      nodes: this.nodes,
    };
  }

  commit(assignmentObj) {
    for (const op of this.problem.ops) {
      const raw = assignmentObj[op.id];
      if (raw === undefined) {
        throw new ValidationError(`assignment missing op '${op.id}'`);
      }
      const value = validateAssignmentValue(op, raw, this.problem);
      if (!this.valueOk(op, value.machine, value.slot, value.tool)) {
        throw new ValidationError(
          `assignment for op '${op.id}' conflicts with already committed assignments`,
        );
      }
      this.apply(op, value, this.nextLevel++);
    }
  }

  totalTardiness() {
    let total = 0;
    for (const op of this.problem.ops) {
      const value = this.assignment.get(op.id);
      if (value) total += tardinessOf(op, value.slot);
    }
    return total;
  }

  replaceOp(opId, newOpRaw) {
    const { problem } = this;
    const index = problem.ops.findIndex((o) => o.id === opId);
    if (index === -1) {
      throw new ValidationError(`unknown op '${opId}' to replace`);
    }
    const oldOp = problem.ops[index];
    const oldValue = this.assignment.get(opId);
    if (oldValue === undefined) {
      throw new ValidationError(`op '${opId}' has no committed assignment`);
    }
    const ctx = {
      machines: problem.machines,
      tools: problem.tools,
      fixtures: problem.fixtures,
      slots: problem.slots,
    };
    const newOp = normalizeOp(newOpRaw, ctx);
    if (newOp.id !== opId && problem.ops.some((o) => o.id === newOp.id)) {
      throw new ValidationError(`duplicate op id '${newOp.id}'`);
    }

    this.undoOpLayer(opId);
    problem.ops.splice(index, 1, newOp);

    const values = this.feasibleValues(newOp);
    if (values.length === 0) {
      const proof = this.analyzeConflict(newOp);
      problem.ops.splice(index, 1, oldOp);
      this.apply(oldOp, oldValue, this.nextLevel++);
      return { status: 'infeasible', op: opId, proof };
    }

    const value = values[0];
    this.apply(newOp, value, this.nextLevel++);
    return {
      status: 'ok',
      op: opId,
      newOp: newOp.id,
      value,
      assignment: Object.fromEntries(this.assignment),
      tardiness: this.totalTardiness(),
    };
  }
}

export function solve(problem, options = {}) {
  const solver = new Solver(problem, options);
  return { result: solver.solve(), solver };
}
