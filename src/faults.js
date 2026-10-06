'use strict';

// Deterministic PRNG so reorder faults are reproducible from the logged seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fault injector: plans unit changes, dropped points and reorderings over an
// intended stream, applies them while inserting into an SPC, and emits a
// JSON-safe log that can be replayed to reproduce the exact same state.
class FaultInjector {
  constructor({ seed = 1 } = {}) {
    this.seed = seed >>> 0;
    this.ops = [];
  }

  injectUnit(id, unit) {
    this.ops.push({ op: 'unit', id, unit });
    return this;
  }

  drop(id) {
    this.ops.push({ op: 'drop', id });
    return this;
  }

  reorder(from, to) {
    this.ops.push({ op: 'reorder', from, to });
    return this;
  }

  run(points, spc) {
    const log = this._compile();
    for (const p of FaultInjector.applyLog(log, points)) spc.insert(p);
    return log;
  }

  _compile() {
    const log = [];
    for (const op of this.ops) {
      if (op.op === 'reorder') {
        const rng = mulberry32(this.seed);
        const idxs = [];
        for (let i = op.from; i <= op.to; i++) idxs.push(i);
        for (let i = idxs.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
        }
        log.push({ op: 'reorder', from: op.from, to: op.to, order: idxs });
      } else {
        log.push({ ...op });
      }
    }
    return log;
  }

  static applyLog(log, points) {
    let list = points.map((p) => ({ ...p }));
    for (const entry of log) {
      if (entry.op === 'drop') {
        list = list.filter((p) => p.id !== entry.id);
      } else if (entry.op === 'unit') {
        list = list.map((p) => (p.id === entry.id ? { ...p, unit: entry.unit } : p));
      } else if (entry.op === 'reorder') {
        const idxs = [];
        for (let i = entry.from; i <= entry.to && i < list.length; i++) idxs.push(i);
        const values = entry.order.filter((i) => i < list.length).map((i) => list[i]);
        idxs.forEach((pos, k) => {
          list[pos] = values[k];
        });
      } else {
        throw new Error(`unknown fault op: ${entry.op}`);
      }
    }
    return list;
  }

  static replay(log, points, spc) {
    for (const p of FaultInjector.applyLog(log, points)) spc.insert(p);
    return spc;
  }
}

module.exports = { FaultInjector, mulberry32 };
