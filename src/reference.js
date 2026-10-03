'use strict';

const {
  normalizeConfig,
  deriveFrameFlag,
  summarizeNight,
  compareFrameRef,
  compareNight,
  canonicalize,
  frameKey,
  calibKey,
} = require('./qc');

function nodeId(...parts) {
  return JSON.stringify(parts);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

// Full-enumeration oracle: every transaction reapplies ops to raw inputs,
// rebuilds the dependency relation from scratch by enumerating all frames,
// and recomputes every flag and summary. Used to cross-check the
// incremental engine.
class ReferenceQC {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.frames = new Map();
    this.calibrations = new Map();
    this.weather = new Map();
    this.declaredNights = new Set();
    this.flags = new Map();
    this.summaries = new Map();
  }

  loadState(state = {}) {
    for (const w of state.weather ?? []) this.weather.set(w.night, { night: w.night, state: w.state });
    for (const c of state.calibrations ?? []) {
      this.calibrations.set(calibKey(c.kind, c.night, c.instrument), { ...c });
    }
    for (const f of state.frames ?? []) {
      this.frames.set(frameKey(f.night, f.frameId), {
        frameId: f.frameId,
        night: f.night,
        instrument: f.instrument,
        metrics: { noise: f.metrics?.noise ?? 0 },
      });
    }
    for (const night of state.nights ?? []) this.declaredNights.add(night);
    this.#recomputeAll();
  }

  applyTransaction(txn = {}) {
    const txnId = txn.id ?? 'txn';
    const budget = txn.budget ?? Infinity;
    const snapshot = this.#snapshot();
    const roots = [];
    const removedFrames = [];
    try {
      for (const op of txn.ops ?? []) this.#applyOp(op, roots, removedFrames);

      const dependents = new Map();
      const addEdge = (from, to) => {
        let set = dependents.get(from);
        if (!set) {
          set = new Set();
          dependents.set(from, set);
        }
        set.add(to);
      };
      for (const frame of this.frames.values()) {
        const frameNode = nodeId('frame', frame.night, frame.frameId);
        addEdge(nodeId('weather', frame.night), frameNode);
        addEdge(nodeId('calib', 'dark', frame.night, frame.instrument), frameNode);
        addEdge(nodeId('calib', 'flat', frame.night, frame.instrument), frameNode);
        addEdge(frameNode, nodeId('summary', frame.night));
      }
      const dirty = new Set();
      const stack = [...roots];
      while (stack.length > 0) {
        const node = stack.pop();
        if (dirty.has(node)) continue;
        dirty.add(node);
        const next = dependents.get(node);
        if (next) for (const dep of next) stack.push(dep);
      }

      const queueFrames = [];
      const queueSummaries = [];
      for (const id of dirty) {
        const [type, night, third] = JSON.parse(id);
        if (type === 'frame') {
          if (this.frames.has(frameKey(night, third))) queueFrames.push({ night, frameId: third });
        } else if (type === 'summary') {
          queueSummaries.push({ night });
        }
      }
      queueFrames.sort(compareFrameRef);
      queueSummaries.sort(compareNight);

      const used = queueFrames.length + queueSummaries.length;
      if (used > budget) {
        fail('E_BUDGET', `recompute budget exceeded: need ${used}, limit ${budget}`);
      }

      const prevFlags = this.flags;
      const prevSummaries = this.summaries;
      this.#recomputeAll();
      for (const ref of queueSummaries) {
        if (!this.summaries.has(ref.night)) {
          this.summaries.set(ref.night, summarizeNight(ref.night, []));
        }
      }

      const flagDiffs = [];
      for (const ref of queueFrames) {
        const key = frameKey(ref.night, ref.frameId);
        const before = prevFlags.get(key) ?? null;
        const after = this.flags.get(key) ?? null;
        if (before !== after) flagDiffs.push({ ...ref, before, after });
      }
      for (const removed of removedFrames) {
        flagDiffs.push({ night: removed.night, frameId: removed.frameId, before: removed.flag, after: null });
      }
      flagDiffs.sort(compareFrameRef);

      const recomputeQueue = [
        ...queueFrames.map((ref) => ({ type: 'frame', ...ref })),
        ...queueSummaries.map((ref) => ({ type: 'summary', ...ref })),
      ];
      return { ok: true, txnId, flagDiffs, recomputeQueue };
    } catch (err) {
      this.frames = snapshot.frames;
      this.calibrations = snapshot.calibrations;
      this.weather = snapshot.weather;
      this.flags = snapshot.flags;
      this.summaries = snapshot.summaries;
      const code = err.code ?? 'E_INVALID';
      return { ok: false, txnId, error: { code, message: err.message } };
    }
  }

  #applyOp(op, roots, removedFrames) {
    switch (op.op) {
      case 'addFrame': {
        const f = op.frame;
        const key = frameKey(f.night, f.frameId);
        if (this.frames.has(key)) fail('E_INVALID', `frame already exists: ${key}`);
        this.frames.set(key, {
          frameId: f.frameId,
          night: f.night,
          instrument: f.instrument,
          metrics: { noise: f.metrics?.noise ?? 0 },
        });
        roots.push(nodeId('frame', f.night, f.frameId));
        break;
      }
      case 'removeFrame': {
        const key = frameKey(op.night, op.frameId);
        const frame = this.frames.get(key);
        if (!frame) fail('E_NOT_FOUND', `no such frame: ${key}`);
        removedFrames.push({ night: frame.night, frameId: frame.frameId, flag: this.flags.get(key) ?? null });
        this.frames.delete(key);
        roots.push(nodeId('summary', frame.night));
        break;
      }
      case 'upsertCalibration': {
        const c = op.calibration;
        this.calibrations.set(calibKey(c.kind, c.night, c.instrument), { ...c });
        roots.push(nodeId('calib', c.kind, c.night, c.instrument));
        break;
      }
      case 'removeCalibration': {
        this.calibrations.delete(calibKey(op.kind, op.night, op.instrument));
        roots.push(nodeId('calib', op.kind, op.night, op.instrument));
        break;
      }
      case 'setWeather': {
        this.weather.set(op.night, { night: op.night, state: op.state });
        roots.push(nodeId('weather', op.night));
        break;
      }
      case 'regroupFrame': {
        const key = frameKey(op.night, op.frameId);
        const frame = this.frames.get(key);
        if (!frame) fail('E_NOT_FOUND', `no such frame: ${key}`);
        const newNight = op.newNight ?? frame.night;
        const newInstrument = op.newInstrument ?? frame.instrument;
        if (newNight === frame.night && newInstrument === frame.instrument) break;
        const newKey = frameKey(newNight, frame.frameId);
        if (newKey !== key && this.frames.has(newKey)) fail('E_INVALID', `frame already exists: ${newKey}`);
        const carriedFlag = this.flags.get(key) ?? null;
        this.frames.delete(key);
        this.frames.set(newKey, { ...frame, night: newNight, instrument: newInstrument });
        roots.push(nodeId('frame', newNight, frame.frameId));
        roots.push(nodeId('summary', frame.night));
        this.flags.delete(key);
        if (carriedFlag !== null) this.flags.set(newKey, carriedFlag);
        break;
      }
      default:
        fail('E_INVALID', `unknown op: ${op.op}`);
    }
  }

  #recomputeAll() {
    this.flags = new Map();
    const frames = [...this.frames.values()].sort(compareFrameRef);
    for (const frame of frames) {
      this.flags.set(frameKey(frame.night, frame.frameId), deriveFrameFlag(frame, this, this.config));
    }
    const nights = new Set([...this.declaredNights, ...this.summaries.keys(), ...frames.map((f) => f.night)]);
    this.summaries = new Map();
    for (const night of [...nights].sort()) {
      const flags = frames.filter((f) => f.night === night).map((f) => this.flags.get(frameKey(f.night, f.frameId)));
      this.summaries.set(night, summarizeNight(night, flags));
    }
  }

  #snapshot() {
    return {
      frames: new Map([...this.frames.entries()].map(([k, v]) => [k, { ...v, metrics: { ...v.metrics } }])),
      calibrations: new Map([...this.calibrations.entries()].map(([k, v]) => [k, { ...v }])),
      weather: new Map([...this.weather.entries()].map(([k, v]) => [k, { ...v }])),
      flags: new Map(this.flags),
      summaries: new Map([...this.summaries.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }
}

module.exports = { ReferenceQC };
