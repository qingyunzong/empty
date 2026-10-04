'use strict';

const MAX_TASKS = 250;
const MAX_DEPS = 2000;

class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInput';
  }
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0;
}

function isValidAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Planner {
  constructor() {
    this.tasks = new Map(); // id -> { dur, cost }
    this.deps = new Map(); // id -> Set of successor ids (a -> b means a before b)
    this.openGroups = []; // stack of { level, ops, committed }
    this.history = []; // closed groups, in close order
  }

  _record(op) {
    if (this.openGroups.length > 0) {
      this.openGroups[this.openGroups.length - 1].ops.push(op);
    }
  }

  _depCount() {
    let n = 0;
    for (const s of this.deps.values()) n += s.size;
    return n;
  }

  addTask(id, dur, cost) {
    if (!isValidId(id)) throw new InvalidInput('task id must be a non-empty string');
    if (!isValidAmount(dur)) throw new InvalidInput('dur must be a finite number >= 0');
    if (!isValidAmount(cost)) throw new InvalidInput('cost must be a finite number >= 0');
    if (this.tasks.has(id)) throw new InvalidInput(`duplicate task id: ${id}`);
    if (this.tasks.size >= MAX_TASKS) throw new InvalidInput(`task limit ${MAX_TASKS} exceeded`);
    this.tasks.set(id, { dur, cost });
    this.deps.set(id, new Set());
    this._record({ type: 'add_task', id });
  }

  dep(a, b) {
    if (!isValidId(a) || !isValidId(b)) throw new InvalidInput('dep endpoints must be task id strings');
    if (!this.tasks.has(a)) throw new InvalidInput(`unknown task: ${a}`);
    if (!this.tasks.has(b)) throw new InvalidInput(`unknown task: ${b}`);
    const succ = this.deps.get(a);
    if (succ.has(b)) return; // duplicate dep is idempotent
    if (this._depCount() >= MAX_DEPS) throw new InvalidInput(`dep limit ${MAX_DEPS} exceeded`);
    succ.add(b);
    this._record({ type: 'dep', a, b });
  }

  groupBegin() {
    this.openGroups.push({ level: this.openGroups.length + 1, ops: [], committed: false });
  }

  groupEnd() {
    if (this.openGroups.length === 0) throw new InvalidInput('group_end without matching group_begin');
    this.history.push(this.openGroups.pop());
  }

  commit() {
    for (const g of this.history) g.committed = true;
  }

  maxLevel() {
    let m = 0;
    for (const g of this.history) m = Math.max(m, g.level);
    for (const g of this.openGroups) m = Math.max(m, g.level);
    return m;
  }

  groupStates() {
    return this.history.map((g) => ({ level: g.level, committed: g.committed }));
  }

  rollback(level) {
    if (!Number.isInteger(level) || level < 0 || level > this.maxLevel()) {
      return 'ROLLBACK_RANGE';
    }
    const kept = [];
    const removed = [];
    for (const g of this.history) {
      (g.level > level ? removed : kept).push(g);
    }
    for (let i = removed.length - 1; i >= 0; i--) this._undoGroup(removed[i]);
    this.history = kept;
    while (this.openGroups.length > 0 && this.openGroups[this.openGroups.length - 1].level > level) {
      this._undoGroup(this.openGroups.pop());
    }
    return 'OK';
  }

  _undoGroup(group) {
    for (let i = group.ops.length - 1; i >= 0; i--) {
      const op = group.ops[i];
      if (op.type === 'add_task') {
        this.deps.delete(op.id);
        for (const s of this.deps.values()) s.delete(op.id);
        this.tasks.delete(op.id);
      } else if (op.type === 'dep') {
        const s = this.deps.get(op.a);
        if (s) s.delete(op.b);
      }
    }
  }

  totalCost() {
    let sum = 0;
    for (const t of this.tasks.values()) sum += t.cost;
    return sum;
  }

  condense() {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    let counter = 0;

    const strongconnect = (v) => {
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of this.deps.get(v)) {
        if (!index.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    };

    for (const v of this.tasks.keys()) {
      if (!index.has(v)) strongconnect(v);
    }

    const sccOf = new Map();
    sccs.forEach((scc, i) => scc.forEach((v) => sccOf.set(v, i)));
    const dag = new Map();
    sccs.forEach((_, i) => dag.set(i, new Set()));
    for (const [a, succ] of this.deps) {
      for (const b of succ) {
        const i = sccOf.get(a);
        const j = sccOf.get(b);
        if (i !== j) dag.get(i).add(j);
      }
    }
    return { sccs, sccOf, dag };
  }

  schedule(budget) {
    if (!isValidAmount(budget)) {
      return { status: 'INVALID_INPUT', error: 'budget must be a finite number >= 0' };
    }

    const { sccs, sccOf } = this.condense();
    const cyclic = [];
    for (const scc of sccs) {
      const selfLoop = scc.length === 1 && this.deps.get(scc[0]).has(scc[0]);
      if (scc.length > 1 || selfLoop) cyclic.push([...scc].sort(compareStrings));
    }

    if (cyclic.length > 0) {
      cyclic.sort((a, b) => compareStrings(a[0], b[0]));
      const inCyclic = new Set();
      for (const scc of cyclic) for (const id of scc) inCyclic.add(id);
      const suggestions = [];
      for (const [a, succ] of this.deps) {
        if (!inCyclic.has(a)) continue;
        for (const b of succ) {
          if (inCyclic.has(b) && sccOf.get(a) === sccOf.get(b)) {
            suggestions.push({ edge: [a, b], cost: this.tasks.get(a).cost });
          }
        }
      }
      suggestions.sort(
        (x, y) => x.cost - y.cost || compareStrings(x.edge[0], y.edge[0]) || compareStrings(x.edge[1], y.edge[1])
      );
      return { status: 'CYCLE', sccs: cyclic, break_suggestions: suggestions };
    }

    const indeg = new Map();
    const preds = new Map();
    for (const id of this.tasks.keys()) {
      indeg.set(id, 0);
      preds.set(id, []);
    }
    for (const [a, succ] of this.deps) {
      for (const b of succ) {
        indeg.set(b, indeg.get(b) + 1);
        preds.get(b).push(a);
      }
    }

    const start = new Map();
    const end = new Map();
    const queue = [];
    for (const id of this.tasks.keys()) {
      if (indeg.get(id) === 0) queue.push(id);
    }
    queue.sort(compareStrings);
    while (queue.length > 0) {
      const v = queue.shift();
      let s = 0;
      for (const p of preds.get(v)) s = Math.max(s, end.get(p));
      start.set(v, s);
      end.set(v, s + this.tasks.get(v).dur);
      for (const w of this.deps.get(v)) {
        indeg.set(w, indeg.get(w) - 1);
        if (indeg.get(w) === 0) {
          queue.push(w);
          queue.sort(compareStrings);
        }
      }
    }

    let makespan = 0;
    for (const e of end.values()) makespan = Math.max(makespan, e);
    const totalCost = this.totalCost();

    if (totalCost > budget) {
      return { status: 'INFEASIBLE', total_cost: totalCost, budget };
    }

    const order = [...this.tasks.keys()].sort(
      (a, b) =>
        start.get(a) - start.get(b) ||
        this.tasks.get(b).dur - this.tasks.get(a).dur ||
        compareStrings(a, b)
    );

    const startObj = {};
    const endObj = {};
    for (const id of order) {
      startObj[id] = start.get(id);
      endObj[id] = end.get(id);
    }

    return {
      status: 'OK',
      order,
      start: startObj,
      end: endObj,
      makespan,
      total_cost: totalCost,
      budget,
    };
  }
}

module.exports = { Planner, InvalidInput, MAX_TASKS, MAX_DEPS };
