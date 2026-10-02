import { createHash } from 'node:crypto';

export const ERRORS = Object.freeze({
  E_TOPO: 'E_TOPO',
  E_CYCLE: 'E_CYCLE',
  E_UNKNOWN_SENSOR: 'E_UNKNOWN_SENSOR',
  E_SENSOR_EXISTS: 'E_SENSOR_EXISTS',
  E_NO_BASE: 'E_NO_BASE',
  E_INVALID: 'E_INVALID',
  E_UNDO_EMPTY: 'E_UNDO_EMPTY',
  E_REDO_EMPTY: 'E_REDO_EMPTY',
});

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries(map) {
  return [...map.entries()].sort(([a], [b]) => compareIds(a, b));
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

const OK = Object.freeze({ ok: true });

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Incrementally maintained sensor calibration chain.
 *
 * Each sensor owns coefficients { raw, offset, scale } and at most one
 * calibration base. The calibrated value of a sensor is computed by
 * applying y = x * scale + offset along the reference chain, starting
 * from the raw reading of the chain root.
 */
export class CalibrationChain {
  #sensors = new Map();
  #baseOf = new Map();
  #dependents = new Map();
  #cache = new Map();
  #version = 0;
  #undoStack = [];
  #redoStack = [];

  /** Instrumentation: number of actual (cache-miss) recomputations. */
  recomputeCount = 0;

  get version() {
    return this.#version;
  }

  // ---- mutation helpers -------------------------------------------------

  #checkpoint() {
    this.#undoStack.push(this.#capture());
    this.#redoStack = [];
  }

  #capture() {
    return structuredClone({
      sensors: this.#sensors,
      baseOf: this.#baseOf,
      dependents: this.#dependents,
      cache: this.#cache,
      version: this.#version,
    });
  }

  #restore(state) {
    this.#sensors = state.sensors;
    this.#baseOf = state.baseOf;
    this.#dependents = state.dependents;
    this.#cache = state.cache;
    this.#version = state.version;
  }

  #addDependent(base, id) {
    let set = this.#dependents.get(base);
    if (!set) {
      set = new Set();
      this.#dependents.set(base, set);
    }
    set.add(id);
  }

  #removeDependent(base, id) {
    const set = this.#dependents.get(base);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.#dependents.delete(base);
  }

  /** Invalidate id and its transitive dependents (the affected closure). */
  #invalidateFrom(id) {
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop();
      this.#cache.delete(cur);
      const set = this.#dependents.get(cur);
      if (set) for (const dep of set) stack.push(dep);
    }
  }

  /** Would making `id` reference `base` create a cycle? */
  #createsCycle(id, base) {
    let cur = base;
    while (cur !== undefined) {
      if (cur === id) return true;
      cur = this.#baseOf.get(cur);
    }
    return false;
  }

  // ---- mutations ----------------------------------------------------------

  addSensor(id, { raw, offset, scale } = {}) {
    if (this.#sensors.has(id)) {
      return fail(ERRORS.E_SENSOR_EXISTS, `sensor already exists: ${id}`);
    }
    if (!isFiniteNumber(raw) || !isFiniteNumber(offset) || !isFiniteNumber(scale)) {
      return fail(ERRORS.E_INVALID, `coefficients must be finite numbers: ${id}`);
    }
    this.#checkpoint();
    this.#sensors.set(id, { raw, offset, scale });
    // Sensors that were blocked on this previously-missing id must recompute.
    this.#invalidateFrom(id);
    this.#version++;
    return { ...OK };
  }

  removeSensor(id) {
    if (!this.#sensors.has(id)) {
      return fail(ERRORS.E_UNKNOWN_SENSOR, `unknown sensor: ${id}`);
    }
    this.#checkpoint();
    const base = this.#baseOf.get(id);
    if (base !== undefined) {
      this.#removeDependent(base, id);
      this.#baseOf.delete(id);
    }
    this.#sensors.delete(id);
    // Dependents keep referencing the now-missing id and become blocked.
    this.#invalidateFrom(id);
    this.#version++;
    return { ...OK };
  }

  /** Coefficient correction: invalidation propagates to the transitive closure. */
  setCoefficients(id, patch = {}) {
    const current = this.#sensors.get(id);
    if (!current) {
      return fail(ERRORS.E_UNKNOWN_SENSOR, `unknown sensor: ${id}`);
    }
    const next = { ...current };
    for (const key of ['raw', 'offset', 'scale']) {
      if (patch[key] !== undefined) {
        if (!isFiniteNumber(patch[key])) {
          return fail(ERRORS.E_INVALID, `coefficient ${key} must be a finite number`);
        }
        next[key] = patch[key];
      }
    }
    this.#checkpoint();
    this.#sensors.set(id, next);
    this.#invalidateFrom(id);
    this.#version++;
    return { ...OK };
  }

  addCalibration(id, base) {
    if (!this.#sensors.has(id)) {
      return fail(ERRORS.E_UNKNOWN_SENSOR, `unknown sensor: ${id}`);
    }
    if (this.#baseOf.has(id)) {
      return fail(ERRORS.E_TOPO, `sensor already has a calibration base: ${id}`);
    }
    if (this.#createsCycle(id, base)) {
      return fail(ERRORS.E_CYCLE, `calibration would create a cycle: ${id} -> ${base}`);
    }
    this.#checkpoint();
    this.#baseOf.set(id, base);
    this.#addDependent(base, id);
    this.#invalidateFrom(id);
    this.#version++;
    return { ...OK };
  }

  removeCalibration(id) {
    if (!this.#sensors.has(id)) {
      return fail(ERRORS.E_UNKNOWN_SENSOR, `unknown sensor: ${id}`);
    }
    const base = this.#baseOf.get(id);
    if (base === undefined) {
      return fail(ERRORS.E_NO_BASE, `sensor has no calibration base: ${id}`);
    }
    this.#checkpoint();
    this.#baseOf.delete(id);
    this.#removeDependent(base, id);
    this.#invalidateFrom(id);
    this.#version++;
    return { ...OK };
  }

  // ---- undo / redo --------------------------------------------------------

  undo() {
    if (this.#undoStack.length === 0) {
      return fail(ERRORS.E_UNDO_EMPTY, 'nothing to undo');
    }
    this.#redoStack.push(this.#capture());
    this.#restore(this.#undoStack.pop());
    return { ...OK };
  }

  redo() {
    if (this.#redoStack.length === 0) {
      return fail(ERRORS.E_REDO_EMPTY, 'nothing to redo');
    }
    this.#undoStack.push(this.#capture());
    this.#restore(this.#redoStack.pop());
    return { ...OK };
  }

  // ---- queries ------------------------------------------------------------

  #resolve(id) {
    const hit = this.#cache.get(id);
    if (hit) return hit;
    this.recomputeCount++;
    const coeffs = this.#sensors.get(id);
    const base = this.#baseOf.get(id);
    let entry;
    if (base === undefined) {
      entry = { value: coeffs.raw * coeffs.scale + coeffs.offset, blocked: false };
    } else if (!this.#sensors.has(base)) {
      entry = { value: null, blocked: true };
    } else {
      const upstream = this.#resolve(base);
      entry = upstream.blocked
        ? { value: null, blocked: true }
        : { value: upstream.value * coeffs.scale + coeffs.offset, blocked: false };
    }
    this.#cache.set(id, entry);
    return entry;
  }

  getResult(id) {
    if (!this.#sensors.has(id)) {
      return fail(ERRORS.E_UNKNOWN_SENSOR, `unknown sensor: ${id}`);
    }
    const resolved = this.#resolve(id);
    return {
      ok: true,
      result: {
        id,
        version: this.#version,
        value: resolved.value,
        confidence: resolved.blocked ? 0 : 1,
        blocked: resolved.blocked,
      },
    };
  }

  /** Deterministic topological ordering (Kahn, lexicographic tie-break). */
  #ordering() {
    const indegree = new Map();
    const outgoing = new Map();
    for (const id of this.#sensors.keys()) {
      indegree.set(id, 0);
      outgoing.set(id, []);
    }
    for (const [id, base] of this.#baseOf) {
      if (this.#sensors.has(id) && this.#sensors.has(base)) {
        outgoing.get(base).push(id);
        indegree.set(id, indegree.get(id) + 1);
      }
    }
    const queue = [];
    for (const id of this.#sensors.keys()) {
      if (indegree.get(id) === 0) queue.push(id);
    }
    queue.sort(compareIds);
    const order = [];
    while (queue.length > 0) {
      const node = queue.shift();
      order.push(node);
      for (const next of outgoing.get(node)) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) {
          let lo = 0;
          let hi = queue.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (compareIds(queue[mid], next) < 0) lo = mid + 1;
            else hi = mid;
          }
          queue.splice(lo, 0, next);
        }
      }
    }
    return order;
  }

  certificate() {
    const coefficients = sortedEntries(this.#sensors).map(
      ([id, c]) => [id, c.raw, c.offset, c.scale],
    );
    const edges = sortedEntries(this.#baseOf).map(([id, base]) => [id, base]);
    return {
      coefficientsHash: sha256(JSON.stringify(coefficients)),
      topologyHash: sha256(JSON.stringify(edges)),
      ordering: this.#ordering(),
    };
  }

  snapshot() {
    const results = {};
    const ids = [...this.#sensors.keys()].sort(compareIds);
    for (const id of ids) {
      const resolved = this.#resolve(id);
      results[id] = {
        id,
        version: this.#version,
        value: resolved.value,
        confidence: resolved.blocked ? 0 : 1,
        blocked: resolved.blocked,
      };
    }
    return {
      version: this.#version,
      results,
      certificate: this.certificate(),
    };
  }

  /** Plain-object view of the authoritative state (for reference checks). */
  getState() {
    const sensors = {};
    for (const [id, c] of this.#sensors) sensors[id] = { ...c };
    const bases = {};
    for (const [id, base] of this.#baseOf) bases[id] = base;
    return { version: this.#version, sensors, bases };
  }
}
