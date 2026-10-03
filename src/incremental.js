'use strict';

const { Engine } = require('./sim');

function pickAmong(candidates, policy, jobs) {
  if (policy === 'fifo') return candidates[0];
  let best = candidates[0];
  for (const id of candidates) {
    const cand = jobs.get(id);
    const cur = jobs.get(best);
    if (cand.priority > cur.priority || (cand.priority === cur.priority && cand.seq < cur.seq)) {
      best = id;
    }
  }
  return best;
}

// Incremental simulator: keeps snapshots of every event boundary so a
// policy change only recomputes the suffix of events actually affected.
// If no recorded choice point would pick a different job under the new
// policy, the cached trace is returned with zero recomputation.
class IncrementalSimulator {
  constructor(config, options = {}) {
    this.config = config;
    this.options = { ...options, keepSnapshots: true };
    this.policy = config.policy ?? 'fifo';
    this.engine = null;
  }

  run() {
    this.engine = new Engine({ ...this.config, policy: this.policy }, this.options);
    this.engine.run();
    return this.summary(0, 0, false);
  }

  setPolicy(policy) {
    if (!this.engine) this.run();
    if (policy === this.policy) {
      return this.summary(this.engine.eventsProcessed, 0, false);
    }
    const old = this.engine;
    for (const cp of old.choicePoints) {
      const pick = pickAmong(cp.candidates, policy, old.jobs);
      if (pick !== cp.chosen) {
        const snap = old.snapshots[cp.eventSeq];
        const engine = Engine.restore(snap, { ...this.config, policy }, this.options, old);
        engine.run();
        const reused = cp.eventSeq;
        const recomputed = engine.eventsProcessed - reused;
        this.engine = engine;
        this.policy = policy;
        return this.summary(reused, recomputed, true);
      }
    }
    // No choice point is affected: the trajectory is provably identical.
    this.policy = policy;
    return this.summary(old.eventsProcessed, 0, false);
  }

  summary(reused, recomputed, changed) {
    const e = this.engine;
    const status = e.violation ? 'VIOLATION' : e.truncated ? 'UNKNOWN' : 'SAFE';
    return {
      status,
      trace: e.trace,
      firstViolation: e.violation,
      reused,
      recomputed,
      changed,
    };
  }
}

module.exports = { IncrementalSimulator };
