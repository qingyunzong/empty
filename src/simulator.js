import { SimError, ERR_CYCLE } from './errors.js';
import {
  createInitialState,
  cloneState,
  stateKey,
  nextEventTime,
  applyCompletions,
  applyArrivals,
  applyCustomEvents,
  pullPass,
  starvedStations,
} from './core.js';

// Deterministic discrete-event simulator.
//
// Per timestamp the event order is fixed:
//   1. settle: completions due now, then work-conserving pulls (fixpoint,
//      so zero-proc-time cascades fully propagate)
//   2. custom events
//   3. arrivals (stable id order)
//   4. settle again
//   5. starvation check
// Same-time arrivals are therefore tie-broken stably by item id.
export class Simulation {
  constructor(norm, opts = {}) {
    this.norm = norm;
    this.policy = norm.policy;
    this.state = createInitialState(norm);
    this.trace = [];
    this.violations = [];
    this.seq = 0;
    this.seenKeys = new Set();
    this.recordCheckpoints = !!opts.recordCheckpoints;
    this.checkpoints = opts.checkpoints ?? null;
    this.emitBound = (ev) => this.emit(ev);
  }

  emit(ev) {
    this.trace.push({ seq: this.seq, time: this.state.time, ...ev });
    this.seq += 1;
  }

  snapshot() {
    return {
      state: cloneState(this.state),
      seq: this.seq,
      traceLength: this.trace.length,
      violationsLength: this.violations.length,
      seenKeys: new Set(this.seenKeys),
    };
  }

  restore(snap) {
    this.state = cloneState(snap.state);
    this.seq = snap.seq;
    this.trace.length = snap.traceLength;
    this.violations.length = snap.violationsLength;
    this.seenKeys = new Set(snap.seenKeys);
  }

  setPolicy(policy) {
    this.policy = policy;
  }

  recordViolation(v) {
    this.violations.push(v);
    if (v.type === 'bufferOverflow') this.emit({ type: 'overflow', item: v.item, buffer: v.buffer });
    else if (v.type === 'starvation') this.emit({ type: 'starvation', station: v.station });
  }

  settle(decisions) {
    const maxIter = (this.norm.arrivals.length + 1) * (this.norm.stations.length + 1) * 2 + 16;
    let iter = 0;
    for (;;) {
      iter += 1;
      if (iter > maxIter) {
        throw new SimError(ERR_CYCLE, `event loop did not quiesce at time ${this.state.time} within ${maxIter} iterations`);
      }
      const { violation, count } = applyCompletions(this.state, this.norm, this.emitBound);
      if (violation) this.recordViolation(violation);
      const progress = pullPass(this.state, this.norm, this.policy, this.emitBound, decisions);
      if (count === 0 && !progress) return;
    }
  }

  // Processes all events at the next event time. Returns false when the run is
  // over (no events left, or the next event lies beyond the horizon).
  step() {
    const t = nextEventTime(this.state, this.norm);
    if (t === null || t > this.norm.horizon) return false;
    this.state.time = t;
    const snapshot = this.recordCheckpoints ? this.snapshot() : null;
    const traceLength = this.trace.length;
    const decisions = this.recordCheckpoints ? [] : null;
    this.settle(decisions);
    applyCustomEvents(this.state, this.norm);
    const vArr = applyArrivals(this.state, this.norm, this.emitBound);
    if (vArr) this.recordViolation(vArr);
    this.settle(decisions);
    const starved = starvedStations(this.state, this.norm);
    if (starved.length) this.recordViolation({ type: 'starvation', station: starved[0], time: t });
    const key = `${t}|${stateKey(this.state)}`;
    if (this.seenKeys.has(key)) {
      throw new SimError(ERR_CYCLE, `identical state reached twice at time ${t}; event cycle detected`);
    }
    this.seenKeys.add(key);
    if (this.recordCheckpoints && decisions.length > 0) {
      this.checkpoints.push({ time: t, snapshot, decisions, traceLength });
    }
    return true;
  }

  run() {
    while (this.step()) {
      if (this.violations.length) break;
    }
    return { trace: this.trace.slice(), firstViolation: this.violations[0] ?? null, violations: this.violations.slice() };
  }
}
