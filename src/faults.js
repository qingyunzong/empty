// faults.js — deterministic fault injection and log replay.
//
// FaultInjector simulates a flaky measurement station:
//   - changeUnit(point, unit): device reports in the wrong unit
//     (value is converted, unit tag is wrong -> engine flags ERR_UNIT)
//   - drop(point): point is lost on the way, never inserted (logged)
//   - reorder(points): points arrive out of order (seeded shuffle, logged)
//
// Everything lands in engine.log; replayLog() rebuilds the exact same
// engine state, so injected faults are fully reproducible.

import { SPCEngine } from './spc.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// how many of `unit` fit in one millimetre
const PER_MM = { mm: 1, cm: 0.1, m: 0.001, in: 1 / 25.4 };

export class FaultInjector {
  constructor(engine, { seed = 1 } = {}) {
    this.engine = engine;
    this.rand = mulberry32(seed);
  }

  // Simulate a device reporting `point` (whose value is in the engine's
  // expected unit) in a different unit: value converted, unit tag attached.
  changeUnit(point, unit) {
    const expected = this.engine.unit.expected ?? 'mm';
    const converted = { ...point, unit };
    if (PER_MM[unit] !== undefined && PER_MM[expected] !== undefined) {
      converted.value = point.value * (PER_MM[unit] / PER_MM[expected]);
    }
    this.engine._record({ op: 'inject', kind: 'unit', id: point.id, unit });
    return this.engine.insert(converted);
  }

  // Simulate a lost measurement: recorded in the log, never inserted.
  drop(point) {
    this.engine._record({ op: 'drop', point: { ...point } });
    return { id: point.id, dropped: true };
  }

  // Insert points in a seeded (deterministic) shuffled order; each point
  // keeps its original seq so the final state equals the in-order state.
  reorder(points) {
    const shuffled = points.map((p, i) => ({ ...p, seq: p.seq ?? i + 1 }));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    this.engine._record({ op: 'inject', kind: 'reorder', ids: shuffled.map((p) => p.id) });
    return shuffled.map((p) => this.engine.insert(p));
  }
}

// Rebuild an engine from its operation log. 'inject'/'drop' markers are
// audit-only and have no state effect; insert/correct/invalidate are
// re-applied verbatim, producing identical alarms and flagged points.
export function replayLog(log, options = {}) {
  const engine = new SPCEngine(options);
  for (const entry of log) {
    if (entry.op === 'insert') engine.insert(entry.point);
    else if (entry.op === 'correct') engine.correct(entry.id, entry.value);
    else if (entry.op === 'invalidate') engine.invalidate(entry.from, entry.to);
    // 'inject' and 'drop' are informational only
  }
  return engine;
}
