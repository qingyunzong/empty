import * as R from './rational.js';

class SchedError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

const err = (code, message) => new SchedError(code, message);

// Validates a raw task object and returns it with exact Rational fields.
// E_RATIONAL: bad/zero-denominator rational. E_EMPTY: release>deadline or duration<=0.
function parseTask(input) {
  if (!input || typeof input !== 'object') throw err('E_SCHEMA', 'task must be an object');
  const { id } = input;
  if (typeof id !== 'string' || id.length === 0) throw err('E_SCHEMA', 'task.id must be a non-empty string');
  let release;
  let deadline;
  let duration;
  let weight;
  try {
    release = R.parse(input.release);
    deadline = R.parse(input.deadline);
    duration = R.parse(input.duration);
    weight = R.parse(input.weight);
  } catch (e) {
    if (e && e.code) throw e;
    throw err('E_RATIONAL');
  }
  if (R.gt(release, deadline)) throw err('E_EMPTY', 'release > deadline');
  if (R.le(duration, R.zero())) throw err('E_EMPTY', 'duration <= 0');
  return { id, release, deadline, duration, weight };
}

function serializeTask(t) {
  return {
    id: t.id,
    release: R.format(t.release),
    deadline: R.format(t.deadline),
    duration: R.format(t.duration),
    weight: R.format(t.weight),
  };
}

export class Scheduler {
  #versions = [new Map()]; // version i = state after i committed mutations
  #cursor = 0;

  get version() {
    return this.#cursor;
  }

  #current() {
    return this.#versions[this.#cursor];
  }

  #commit(next) {
    this.#versions.length = this.#cursor + 1; // drop redo tail
    this.#versions.push(next);
    this.#cursor += 1;
    return { ok: true, version: this.#cursor };
  }

  add(task) {
    let parsed;
    try {
      parsed = parseTask(task);
    } catch (e) {
      return { ok: false, error: e.code ?? 'E_SCHEMA' };
    }
    if (this.#current().has(parsed.id)) return { ok: false, error: 'E_DUP' };
    const next = new Map(this.#current());
    next.set(parsed.id, parsed);
    return this.#commit(next);
  }

  // patch: any subset of {release, deadline, duration, weight}; omitted fields keep old values.
  // Invalid patches are rejected without creating a new version.
  update(id, patch = {}) {
    const old = this.#current().get(id);
    if (!old) return { ok: false, error: 'E_NOTFOUND' };
    const merged = { id };
    for (const f of ['release', 'deadline', 'duration', 'weight']) {
      merged[f] = patch[f] !== undefined ? patch[f] : old[f];
    }
    let parsed;
    try {
      parsed = parseTask(merged);
    } catch (e) {
      return { ok: false, error: e.code ?? 'E_SCHEMA' };
    }
    const next = new Map(this.#current());
    next.set(id, parsed);
    return this.#commit(next);
  }

  remove(id) {
    if (!this.#current().has(id)) return { ok: false, error: 'E_NOTFOUND' };
    const next = new Map(this.#current());
    next.delete(id);
    return this.#commit(next);
  }

  undo() {
    if (this.#cursor === 0) return { ok: false, error: 'E_UNDO' };
    this.#cursor -= 1;
    return { ok: true, version: this.#cursor };
  }

  redo() {
    if (this.#cursor >= this.#versions.length - 1) return { ok: false, error: 'E_REDO' };
    this.#cursor += 1;
    return { ok: true, version: this.#cursor };
  }

  state() {
    return [...this.#current().values()]
      .map(serializeTask)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Exact max-weight feasible subset. Tasks may start at any rational time inside
  // their window; execution intervals must not overlap (touching endpoints are OK).
  // Ties on weight are broken by the lexicographically smallest sorted id list.
  solve() {
    const tasks = [...this.#current().values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = tasks.length;
    const bit = (i) => 1n << BigInt(i);

    // minEnd[mask] = earliest possible completion time of exactly this set, or null
    // if infeasible. DP over choice of last task (exact, no floats).
    const total = 1n << BigInt(n);
    const minEnd = new Map([[0n, R.zero()]]);
    const parent = new Map();
    for (let mask = 1n; mask < total; mask += 1n) {
      let best = null;
      let bestT = -1;
      for (let t = 0; t < n; t += 1) {
        if (!(mask & bit(t))) continue;
        const prev = minEnd.get(mask ^ bit(t));
        if (prev === null || prev === undefined) continue;
        const start = R.max(prev, tasks[t].release);
        const end = R.add(start, tasks[t].duration);
        if (R.le(end, tasks[t].deadline) && (best === null || R.lt(end, best))) {
          best = end;
          bestT = t;
        }
      }
      minEnd.set(mask, best);
      if (bestT >= 0) parent.set(mask, bestT);
    }

    // Branch and bound over subsets in sorted-id order.
    const remPos = new Array(n + 1);
    remPos[n] = R.zero();
    for (let i = n - 1; i >= 0; i -= 1) {
      remPos[i] = R.add(remPos[i + 1], R.max(tasks[i].weight, R.zero()));
    }
    const lexSmaller = (a, b) => {
      for (let t = 0; t < n; t += 1) {
        const x = (a >> BigInt(t)) & 1n;
        const y = (b >> BigInt(t)) & 1n;
        if (x !== y) return x === 1n;
      }
      return false;
    };
    let bestWeight = null;
    let bestMask = 0n;
    const dfs = (i, mask, w) => {
      if (bestWeight !== null && R.lt(R.add(w, remPos[i]), bestWeight)) return;
      if (i === n) {
        if (minEnd.get(mask) === null) return;
        if (
          bestWeight === null ||
          R.gt(w, bestWeight) ||
          (R.eq(w, bestWeight) && lexSmaller(mask, bestMask))
        ) {
          bestWeight = w;
          bestMask = mask;
        }
        return;
      }
      dfs(i + 1, mask | bit(i), R.add(w, tasks[i].weight));
      dfs(i + 1, mask, w);
    };
    dfs(0, 0n, R.zero());

    // Reconstruct one exact schedule from the DP parents.
    const order = [];
    for (let m = bestMask; m !== 0n; m ^= bit(parent.get(m))) order.push(parent.get(m));
    order.reverse();
    const jobs = [];
    let cur = null;
    for (const t of order) {
      const task = tasks[t];
      const start = cur === null ? task.release : R.max(cur, task.release);
      const end = R.add(start, task.duration);
      jobs.push({ id: task.id, start: R.format(start), end: R.format(end) });
      cur = end;
    }

    // Certificate: for every unselected task, the selected tasks whose windows
    // overlap it with positive length (touching endpoints do not conflict).
    const selected = new Set(jobs.map((j) => j.id));
    const certificate = {};
    for (const t of tasks) {
      if (selected.has(t.id)) continue;
      const conflicts = [];
      for (const s of tasks) {
        if (!selected.has(s.id)) continue;
        const lo = R.max(t.release, s.release);
        const hi = R.min(t.deadline, s.deadline);
        if (R.lt(lo, hi)) conflicts.push(s.id);
      }
      conflicts.sort();
      certificate[t.id] = conflicts;
    }

    return {
      ok: true,
      version: this.#cursor,
      weight: R.format(bestWeight),
      jobs,
      certificate,
    };
  }
}
