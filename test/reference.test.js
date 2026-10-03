import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { referenceRun, mulberry32 } from './helpers/reference.js';

const TEMPLATES = [
  (id, ts) => ({ id, ts, device: 'D1', lot: 'L1', kind: 'quality.hold', payload: {} }),
  (id, ts) => ({ id, ts, device: 'D1', lot: 'L1', kind: 'quality.release', payload: {} }),
  (id, ts) => ({ id, ts, device: 'D1', lot: 'L1', kind: 'quality.check', payload: { result: 'fail' } }),
  (id, ts) => ({ id, ts, device: 'D1', lot: 'L1', kind: 'device.alarm', payload: {} }),
  (id, ts) => ({ id, ts, device: 'D1', lot: 'L1', kind: 'device.clear', payload: {} }),
];

function engineRun(events, opts) {
  const engine = createEngine(opts);
  engine.ingestBatch(events);
  return engine.debugState();
}

function compare(events, label, opts) {
  const actual = engineRun(events, opts);
  const expected = referenceRun(events, opts);
  assert.deepEqual(actual, expected, `mismatch for ${label}: ${JSON.stringify(events)}`);
}

test('exhaustive enumeration of all sequences, n <= 6, alphabet of 5', () => {
  let count = 0;
  const build = (len) => {
    const total = Math.pow(TEMPLATES.length, len);
    for (let code = 0; code < total; code++) {
      let x = code;
      const events = [];
      for (let pos = 0; pos < len; pos++) {
        const t = x % TEMPLATES.length;
        x = Math.floor(x / TEMPLATES.length);
        events.push(TEMPLATES[t](`e${pos}`, (pos + 1) * 1000));
      }
      compare(events, `seq#${code} len=${len}`);
      count++;
    }
  };
  for (let len = 0; len <= 6; len++) build(len);
  assert.equal(count, 19531);
});

test('seeded random sequences, n in 7..10, with parents/ghosts/cycles/shuffle', () => {
  const rng = mulberry32(20261004);
  for (let iter = 0; iter < 500; iter++) {
    const n = 7 + Math.floor(rng() * 4); // 7..10
    const events = [];
    for (let pos = 0; pos < n; pos++) {
      const t = Math.floor(rng() * TEMPLATES.length);
      const e = TEMPLATES[t](`r${iter}-e${pos}`, Math.floor(rng() * 8000));
      const roll = rng();
      if (roll < 0.3 && pos > 0) {
        const deps = Math.floor(rng() * 2) + 1;
        e.parents = [];
        for (let d = 0; d < deps; d++) e.parents.push(`r${iter}-e${Math.floor(rng() * pos)}`);
      } else if (roll < 0.35) {
        e.parents = [`ghost-${Math.floor(rng() * 3)}`];
      } else if (roll < 0.37) {
        e.parents = [e.id];
      }
      events.push(e);
    }
    // shuffle delivery order; engine must reorder deterministically
    for (let i = events.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }
    compare(events, `random iter=${iter}`);
  }
});

test('duplicate delivery does not change state', () => {
  const rng = mulberry32(7);
  for (let iter = 0; iter < 100; iter++) {
    const n = 1 + Math.floor(rng() * 10);
    const events = [];
    for (let pos = 0; pos < n; pos++) {
      events.push(TEMPLATES[Math.floor(rng() * TEMPLATES.length)](`d${iter}-e${pos}`, Math.floor(rng() * 5000)));
    }
    const doubled = [...events, ...events];
    for (let i = doubled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [doubled[i], doubled[j]] = [doubled[j], doubled[i]];
    }
    compare(doubled, `dup iter=${iter}`);
  }
});
