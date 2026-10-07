/**
 * Maintenance work-order planner.
 *
 * Semantics
 * ---------
 * - add_task(id, dur, cost): a work order with duration and resource cost.
 * - dep(a, b): task `a` must finish before task `b` starts.
 * - Tasks are executed with unlimited parallelism: a task (or SCC block)
 *   starts at the max end of its predecessors. Within a cyclic strongly
 *   connected component the members run serially in id lexicographic order
 *   (the cycle is "compressed" into one block).
 * - Topological tie-breaking ("同层多解"): among ready components pick the
 *   one with the smallest total duration, then smallest member id
 *   (lexicographic). This yields the unique order that is element-wise
 *   minimal under the (duration, id) comparator.
 * - schedule(budget): total_cost is the sum of ALL task costs; tasks are
 *   never dropped. If total_cost > budget the status is INFEASIBLE.
 *   Status precedence: INVALID_INPUT > CYCLE > INFEASIBLE > OK.
 * - Break-edge suggestion cost: breaking dep(a, b) is priced at the cost
 *   of the target task b. Suggestions are sorted by cost ascending, then
 *   (from, to) lexicographic.
 *
 * Groups / rollback
 * -----------------
 * - group_begin opens a new nesting level and records a snapshot of the
 *   state (tasks, deps, per-level committed flags) as it was before any
 *   operation of that level.
 * - group_end closes the current level; its snapshot is retained.
 * - commit marks every currently open level as committed.
 * - rollback(level) restores the snapshot taken when `level` began and
 *   discards all deeper snapshots. Level 0 is the base state. Rolling back
 *   to a level with no retained snapshot returns ROLLBACK_RANGE and leaves
 *   the state untouched.
 */

export const STATUS = Object.freeze({
  OK: 'OK',
  CYCLE: 'CYCLE',
  INFEASIBLE: 'INFEASIBLE',
  INVALID_INPUT: 'INVALID_INPUT',
  ROLLBACK_RANGE: 'ROLLBACK_RANGE',
});

function isNonNegFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0;
}

function tarjanScc(ids, adj) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let counter = 0;

  function strongconnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
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
      out.push(scc);
    }
  }

  for (const v of ids) {
    if (!index.has(v)) strongconnect(v);
  }
  return out;
}

export class Planner {
  constructor() {
    this._tasks = new Map(); // id -> { dur, cost }
    this._deps = []; // array of [a, b], deduplicated
    this._depSet = new Set();
    this._levels = [{ committed: true }]; // committed flag per level index
    this._depth = 0;
    this._snapshots = [this._capture()];
  }

  _capture() {
    return {
      tasks: new Map([...this._tasks].map(([id, t]) => [id, { ...t }])),
      deps: this._deps.map((pair) => [...pair]),
      levels: this._levels.map((l) => ({ ...l })),
    };
  }

  _restore(snap) {
    this._tasks = new Map([...snap.tasks].map(([id, t]) => [id, { ...t }]));
    this._deps = snap.deps.map((pair) => [...pair]);
    this._depSet = new Set(this._deps.map(([a, b]) => `${a}→${b}`));
    this._levels = snap.levels.map((l) => ({ ...l }));
  }

  get depth() {
    return this._depth;
  }

  get taskCount() {
    return this._tasks.size;
  }

  get depCount() {
    return this._deps.length;
  }

  isCommitted(level) {
    if (!Number.isInteger(level) || level < 0 || level > this._depth) return null;
    return this._levels[level].committed;
  }

  addTask(id, dur, cost) {
    if (!isValidId(id)) {
      return { status: STATUS.INVALID_INPUT, error: 'id must be a non-empty string' };
    }
    if (this._tasks.has(id)) {
      return { status: STATUS.INVALID_INPUT, error: `duplicate task id: ${id}` };
    }
    if (!isNonNegFinite(dur)) {
      return { status: STATUS.INVALID_INPUT, error: 'dur must be a non-negative finite number' };
    }
    if (!isNonNegFinite(cost)) {
      return { status: STATUS.INVALID_INPUT, error: 'cost must be a non-negative finite number' };
    }
    this._tasks.set(id, { dur, cost });
    return { status: STATUS.OK };
  }

  dep(a, b) {
    if (!isValidId(a) || !isValidId(b)) {
      return { status: STATUS.INVALID_INPUT, error: 'dep endpoints must be non-empty strings' };
    }
    if (!this._tasks.has(a)) {
      return { status: STATUS.INVALID_INPUT, error: `unknown task: ${a}` };
    }
    if (!this._tasks.has(b)) {
      return { status: STATUS.INVALID_INPUT, error: `unknown task: ${b}` };
    }
    const key = `${a}→${b}`;
    if (!this._depSet.has(key)) {
      this._depSet.add(key);
      this._deps.push([a, b]);
    }
    return { status: STATUS.OK };
  }

  groupBegin() {
    this._depth += 1;
    this._snapshots[this._depth] = this._capture();
    this._levels[this._depth] = { committed: false };
    return { status: STATUS.OK, level: this._depth };
  }

  groupEnd() {
    if (this._depth === 0) {
      return { status: STATUS.INVALID_INPUT, error: 'no open group to end' };
    }
    this._levels.length = this._depth; // drop the current level entry
    this._depth -= 1;
    return { status: STATUS.OK, level: this._depth };
  }

  commit() {
    for (let l = 0; l <= this._depth; l += 1) {
      this._levels[l].committed = true;
    }
    return { status: STATUS.OK, committedThrough: this._depth };
  }

  rollback(level) {
    if (!Number.isInteger(level)) {
      return { status: STATUS.INVALID_INPUT, error: 'level must be an integer' };
    }
    if (level < 0 || level >= this._snapshots.length || this._snapshots[level] === null) {
      return { status: STATUS.ROLLBACK_RANGE, error: `no snapshot for level ${level}` };
    }
    this._restore(this._snapshots[level]);
    this._depth = level;
    this._levels.length = level + 1;
    if (!this._levels[level]) this._levels[level] = { committed: false };
    // discard deeper snapshots
    this._snapshots.length = level + 1;
    return { status: STATUS.OK, level };
  }

  schedule(budget) {
    if (!isNonNegFinite(budget)) {
      return { status: STATUS.INVALID_INPUT, error: 'budget must be a non-negative finite number' };
    }

    const ids = [...this._tasks.keys()];
    const adj = new Map(ids.map((id) => [id, []]));
    for (const [a, b] of this._deps) adj.get(a).push(b);

    const rawSccs = tarjanScc(ids, adj);
    const compOf = new Map();
    const comps = rawSccs.map((members, ci) => {
      const sorted = [...members].sort();
      let dur = 0;
      let cost = 0;
      for (const id of sorted) {
        const t = this._tasks.get(id);
        dur += t.dur;
        cost += t.cost;
        compOf.set(id, ci);
      }
      return { members: sorted, dur, cost, key: sorted[0], selfLoop: false };
    });

    for (const [a, b] of this._deps) {
      if (a === b) comps[compOf.get(a)].selfLoop = true;
    }

    // Condensation edges (deduplicated).
    const compAdj = comps.map(() => new Set());
    const compIndeg = comps.map(() => 0);
    for (const [a, b] of this._deps) {
      const ca = compOf.get(a);
      const cb = compOf.get(b);
      if (ca !== cb && !compAdj[ca].has(cb)) {
        compAdj[ca].add(cb);
        compIndeg[cb] += 1;
      }
    }

    // Kahn with tie-break: smallest (total duration, smallest member id).
    const ready = [];
    for (let ci = 0; ci < comps.length; ci += 1) {
      if (compIndeg[ci] === 0) ready.push(ci);
    }
    const pickOrder = [];
    const indeg = [...compIndeg];
    while (ready.length > 0) {
      ready.sort((x, y) => {
        if (comps[x].dur !== comps[y].dur) return comps[x].dur - comps[y].dur;
        return comps[x].key < comps[y].key ? -1 : comps[x].key > comps[y].key ? 1 : 0;
      });
      const ci = ready.shift();
      pickOrder.push(ci);
      for (const cj of compAdj[ci]) {
        indeg[cj] -= 1;
        if (indeg[cj] === 0) ready.push(cj);
      }
    }

    // Earliest-start times on the condensation DAG (parallel execution).
    const compStart = comps.map(() => 0);
    const compEnd = comps.map(() => 0);
    const compPreds = comps.map(() => []);
    for (let ca = 0; ca < comps.length; ca += 1) {
      for (const cb of compAdj[ca]) compPreds[cb].push(ca);
    }
    for (const ci of pickOrder) {
      let start = 0;
      for (const cp of compPreds[ci]) start = Math.max(start, compEnd[cp]);
      compStart[ci] = start;
      compEnd[ci] = start + comps[ci].dur;
    }

    const order = [];
    const start = {};
    const end = {};
    for (const ci of pickOrder) {
      let cursor = compStart[ci];
      for (const id of comps[ci].members) {
        order.push(id);
        start[id] = cursor;
        cursor += this._tasks.get(id).dur;
        end[id] = cursor;
      }
    }
    const makespan = compEnd.length > 0 ? Math.max(...compEnd) : 0;

    let totalCost = 0;
    for (const t of this._tasks.values()) totalCost += t.cost;

    const cyclicSccs = comps
      .filter((c) => c.members.length > 1 || c.selfLoop)
      .map((c) => c.members);

    const breakEdges = [];
    for (const [a, b] of this._deps) {
      if (compOf.get(a) === compOf.get(b)) {
        breakEdges.push({ from: a, to: b, cost: this._tasks.get(b).cost });
      }
    }
    breakEdges.sort((x, y) => {
      if (x.cost !== y.cost) return x.cost - y.cost;
      if (x.from !== y.from) return x.from < y.from ? -1 : 1;
      return x.to < y.to ? -1 : x.to > y.to ? 1 : 0;
    });

    let status = STATUS.OK;
    if (cyclicSccs.length > 0) status = STATUS.CYCLE;
    else if (totalCost > budget) status = STATUS.INFEASIBLE;

    return {
      status,
      order,
      start,
      end,
      makespan,
      total_cost: totalCost,
      budget,
      sccs: cyclicSccs,
      break_edges: breakEdges,
    };
  }
}
