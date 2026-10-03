'use strict';

const crypto = require('node:crypto');
const { DependencyGraph } = require('./graph');
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

const WEATHER_STATES = new Set(['clear', 'degraded', 'blocked']);
const CALIB_KINDS = new Set(['dark', 'flat']);

function nodeId(...parts) {
  return JSON.stringify(parts);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

class QcEngine {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.frames = new Map();
    this.calibrations = new Map();
    this.weather = new Map();
    this.flags = new Map();
    this.summaries = new Map();
    this.graph = new DependencyGraph();
    this.txnCounter = 0;
  }

  loadState(state = {}) {
    for (const w of state.weather ?? []) {
      if (!WEATHER_STATES.has(w.state)) fail('E_INVALID', `bad weather state: ${w.state}`);
      this.weather.set(w.night, { night: w.night, state: w.state });
    }
    for (const c of state.calibrations ?? []) {
      if (!CALIB_KINDS.has(c.kind)) fail('E_INVALID', `bad calibration kind: ${c.kind}`);
      this.calibrations.set(calibKey(c.kind, c.night, c.instrument), { ...c });
    }
    for (const f of state.frames ?? []) {
      const frame = this.#normalizeFrame(f);
      const key = frameKey(frame.night, frame.frameId);
      if (this.frames.has(key)) fail('E_INVALID', `duplicate frame ${key}`);
      this.frames.set(key, frame);
    }
    this.#rebuildAll(new Set(state.nights ?? []));
  }

  getState() {
    return {
      frames: [...this.frames.values()].sort(compareFrameRef).map((f) => ({ ...f, metrics: { ...f.metrics } })),
      calibrations: [...this.calibrations.values()]
        .sort((a, b) => (calibKey(a.kind, a.night, a.instrument) < calibKey(b.kind, b.night, b.instrument) ? -1 : 1))
        .map((c) => ({ ...c })),
      weather: [...this.weather.values()].sort(compareNight).map((w) => ({ ...w })),
      flags: Object.fromEntries([...this.flags.entries()].sort()),
      summaries: [...this.summaries.values()].sort(compareNight).map((s) => ({ ...s })),
    };
  }

  applyTransaction(txn = {}) {
    this.txnCounter += 1;
    const txnId = txn.id ?? `txn-${this.txnCounter}`;
    const budget = txn.budget ?? Infinity;
    const snapshot = this.#snapshotInputs();
    const roots = new Set();
    const removedFrames = [];
    try {
      for (const op of txn.ops ?? []) this.#applyOp(op, roots, removedFrames);
      const dirty = this.graph.invalidate([...roots]);

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

      const flagDiffs = [];
      for (const ref of queueFrames) {
        const key = frameKey(ref.night, ref.frameId);
        const before = this.flags.get(key) ?? null;
        const after = deriveFrameFlag(this.frames.get(key), this, this.config);
        this.flags.set(key, after);
        if (before !== after) flagDiffs.push({ ...ref, before, after });
      }
      for (const removed of removedFrames) {
        flagDiffs.push({ night: removed.night, frameId: removed.frameId, before: removed.flag, after: null });
      }
      flagDiffs.sort(compareFrameRef);

      const summaryDiffs = [];
      for (const ref of queueSummaries) {
        const before = this.summaries.get(ref.night) ?? null;
        const after = this.#computeSummary(ref.night);
        this.summaries.set(ref.night, after);
        if (canonicalize(before) !== canonicalize(after)) {
          summaryDiffs.push({ night: ref.night, before, after });
        }
      }

      const recomputeQueue = [
        ...queueFrames.map((ref) => ({ type: 'frame', ...ref })),
        ...queueSummaries.map((ref) => ({ type: 'summary', ...ref })),
      ];
      const certificate = {
        txnId,
        invalidated: [...dirty].sort(),
        recomputed: recomputeQueue,
        flagDiffs,
        summaryDiffs,
        budget: { limit: budget === Infinity ? null : budget, used },
        digest: this.#digest(),
      };
      return { ok: true, txnId, flagDiffs, recomputeQueue, certificate };
    } catch (err) {
      this.#restoreInputs(snapshot);
      const code = err.code ?? 'E_INVALID';
      return { ok: false, txnId, error: { code, message: err.message } };
    }
  }

  #normalizeFrame(f) {
    if (!f || typeof f.frameId !== 'string' || typeof f.night !== 'string' || typeof f.instrument !== 'string') {
      fail('E_INVALID', `frame requires frameId, night and instrument: ${JSON.stringify(f)}`);
    }
    const noise = f.metrics?.noise ?? 0;
    if (typeof noise !== 'number' || Number.isNaN(noise)) {
      fail('E_INVALID', `frame ${f.frameId} has non-numeric noise`);
    }
    return { frameId: f.frameId, night: f.night, instrument: f.instrument, metrics: { noise } };
  }

  #frameNode(frame) {
    return nodeId('frame', frame.night, frame.frameId);
  }

  #addFrameEdges(frame) {
    const frameNode = this.#frameNode(frame);
    this.graph.addEdge(nodeId('weather', frame.night), frameNode);
    this.graph.addEdge(nodeId('calib', 'dark', frame.night, frame.instrument), frameNode);
    this.graph.addEdge(nodeId('calib', 'flat', frame.night, frame.instrument), frameNode);
    this.graph.addEdge(frameNode, nodeId('summary', frame.night));
  }

  #removeFrameEdges(frame) {
    const frameNode = this.#frameNode(frame);
    this.graph.removeEdge(nodeId('weather', frame.night), frameNode);
    this.graph.removeEdge(nodeId('calib', 'dark', frame.night, frame.instrument), frameNode);
    this.graph.removeEdge(nodeId('calib', 'flat', frame.night, frame.instrument), frameNode);
    this.graph.removeEdge(frameNode, nodeId('summary', frame.night));
  }

  #applyOp(op, roots, removedFrames) {
    switch (op.op) {
      case 'addFrame': {
        const frame = this.#normalizeFrame(op.frame);
        const key = frameKey(frame.night, frame.frameId);
        if (this.frames.has(key)) fail('E_INVALID', `frame already exists: ${key}`);
        this.frames.set(key, frame);
        this.#addFrameEdges(frame);
        roots.add(this.#frameNode(frame));
        break;
      }
      case 'removeFrame': {
        const key = frameKey(op.night, op.frameId);
        const frame = this.frames.get(key);
        if (!frame) fail('E_NOT_FOUND', `no such frame: ${key}`);
        removedFrames.push({ night: frame.night, frameId: frame.frameId, flag: this.flags.get(key) ?? null });
        this.#removeFrameEdges(frame);
        this.frames.delete(key);
        this.flags.delete(key);
        roots.add(nodeId('summary', frame.night));
        break;
      }
      case 'upsertCalibration': {
        const c = op.calibration;
        if (!c || !CALIB_KINDS.has(c.kind)) fail('E_INVALID', `bad calibration: ${JSON.stringify(c)}`);
        this.calibrations.set(calibKey(c.kind, c.night, c.instrument), { ...c });
        roots.add(nodeId('calib', c.kind, c.night, c.instrument));
        break;
      }
      case 'removeCalibration': {
        if (!CALIB_KINDS.has(op.kind)) fail('E_INVALID', `bad calibration kind: ${op.kind}`);
        this.calibrations.delete(calibKey(op.kind, op.night, op.instrument));
        roots.add(nodeId('calib', op.kind, op.night, op.instrument));
        break;
      }
      case 'setWeather': {
        if (!WEATHER_STATES.has(op.state)) fail('E_INVALID', `bad weather state: ${op.state}`);
        this.weather.set(op.night, { night: op.night, state: op.state });
        roots.add(nodeId('weather', op.night));
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
        this.#removeFrameEdges(frame);
        this.frames.delete(key);
        this.flags.delete(key);
        const moved = { ...frame, night: newNight, instrument: newInstrument };
        this.frames.set(newKey, moved);
        if (carriedFlag !== null) this.flags.set(newKey, carriedFlag);
        this.#addFrameEdges(moved);
        roots.add(this.#frameNode(moved));
        roots.add(nodeId('summary', frame.night));
        break;
      }
      default:
        fail('E_INVALID', `unknown op: ${op.op}`);
    }
  }

  #computeSummary(night) {
    const flags = [...this.frames.values()]
      .filter((f) => f.night === night)
      .sort(compareFrameRef)
      .map((f) => this.flags.get(frameKey(f.night, f.frameId)));
    return summarizeNight(night, flags);
  }

  #rebuildAll(preserveNights = new Set()) {
    this.graph = new DependencyGraph();
    for (const frame of this.frames.values()) this.#addFrameEdges(frame);
    this.flags.clear();
    const frames = [...this.frames.values()].sort(compareFrameRef);
    for (const frame of frames) {
      this.flags.set(frameKey(frame.night, frame.frameId), deriveFrameFlag(frame, this, this.config));
    }
    const nights = new Set([...preserveNights, ...frames.map((f) => f.night)]);
    this.summaries.clear();
    for (const night of [...nights].sort()) {
      this.summaries.set(night, this.#computeSummary(night));
    }
  }

  #snapshotInputs() {
    return {
      frames: new Map([...this.frames.entries()].map(([k, v]) => [k, { ...v, metrics: { ...v.metrics } }])),
      calibrations: new Map([...this.calibrations.entries()].map(([k, v]) => [k, { ...v }])),
      weather: new Map([...this.weather.entries()].map(([k, v]) => [k, { ...v }])),
      summaryNights: new Set(this.summaries.keys()),
    };
  }

  #restoreInputs(snapshot) {
    this.frames = snapshot.frames;
    this.calibrations = snapshot.calibrations;
    this.weather = snapshot.weather;
    this.#rebuildAll(snapshot.summaryNights);
  }

  #digest() {
    const payload = {
      config: this.config,
      flags: [...this.flags.entries()].sort(),
      summaries: [...this.summaries.values()].sort(compareNight),
    };
    return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
  }
}

module.exports = { QcEngine };
