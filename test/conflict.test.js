import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, prepare } from '../src/analyze.js';
import { normalizeConfig, simulate, signature } from '../src/simulate.js';
import { EXIT } from '../src/errors.js';
import { mulberry32 } from '../testing/helpers.mjs';

const measure = (id, length, deps = []) => ({
  id, type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});
const cut = (id, length, deps = []) => ({
  id, type: 'cut', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});

test('concurrent measure and cut with incomparable outcome report conflict with both ids', () => {
  const { error, conflict } = analyze([measure('e1', 60), cut('e2', 60)], { tools: { T1: 100 } });
  assert.equal(error.code, EXIT.CONFLICT);
  assert.deepEqual(new Set([conflict.a, conflict.b]), new Set(['e1', 'e2']));
  assert.match(error.message, /e1/);
  assert.match(error.message, /e2/);
});

test('causally ordered measure and cut never conflict', () => {
  const { error, outcome } = analyze([measure('e1', 60), cut('e2', 60, ['e1'])], { tools: { T1: 100 } });
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.overspendPoint, 'e2');
});

test('concurrent events with order-independent outcome do not conflict', () => {
  const { error, outcome } = analyze([measure('e1', 30), cut('e2', 30)], { tools: { T1: 100 } });
  assert.equal(error, null);
  assert.equal(outcome.tools.T1.used, 60);
});

function extensionsOf(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const results = [];
  const walk = (prefix, rest) => {
    if (rest.length === 0) {
      results.push(prefix);
      return;
    }
    for (const id of rest) {
      if (byId.get(id).deps.every((d) => prefix.includes(d))) {
        walk([...prefix, id], rest.filter((x) => x !== id));
      }
    }
  };
  walk([], events.map((e) => e.id));
  return results.map((ext) => ext.map((id) => byId.get(id)));
}

test('conflict detection matches brute-force enumeration for logs of at most 7 events', () => {
  const rng = mulberry32(20261005);
  for (let iter = 0; iter < 100; iter += 1) {
    const n = 2 + Math.floor(rng() * 6);
    const events = [];
    for (let i = 0; i < n; i += 1) {
      const deps = events.filter(() => rng() < 0.35).map((e) => e.id);
      events.push({
        id: `e${i}`,
        type: rng() < 0.5 ? 'measure' : 'cut',
        tool: 'T1',
        order: 'O1',
        op: 'OP1',
        seg: 'S1',
        length: 1 + Math.floor(rng() * 40),
        deps,
      });
    }
    const rawConfig = {
      tools: { T1: 20 + Math.floor(rng() * 60) },
      segments: { 'O1/OP1/S1': 30 + Math.floor(rng() * 80) },
      operations: { 'O1/OP1': 40 + Math.floor(rng() * 100) },
      orders: { O1: 50 + Math.floor(rng() * 120) },
    };
    const { byId, pastOf } = prepare(events);
    const config = normalizeConfig(rawConfig);
    const ctx = { byId, pastOf };
    const sigs = new Set(extensionsOf(events).map((ext) => signature(simulate(ext, ctx, config))));
    const enumerationSaysConflict = sigs.size > 1;
    const { conflict } = analyze(events, rawConfig);
    assert.equal(
      conflict !== null,
      enumerationSaysConflict,
      `iteration ${iter}: detection=${conflict !== null} enumeration=${enumerationSaysConflict} log=${JSON.stringify(events)} config=${JSON.stringify(rawConfig)}`,
    );
  }
});
