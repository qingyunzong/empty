import test from 'node:test';
import assert from 'node:assert/strict';
import { injectFaults, replayInjections } from '../src/inject.js';
import { analyze } from '../src/analyze.js';

const base = () => [
  { id: 'a', type: 'run', start: 0, end: 1000 },
  { id: 'f', type: 'fault', start: 200, end: 300 },
  { id: 'c', type: 'changeover', start: 1000, end: 2000 },
];

test('injection is deterministic for a given seed and spec', () => {
  const spec = { skew: { count: 2, maxDeltaMs: 5000 }, lost: { count: 1 }, duplicate: { count: 1 } };
  const first = injectFaults(base(), spec, 42);
  const second = injectFaults(base(), spec, 42);
  assert.deepEqual(first, second);
});

test('injection log replays exactly onto the original events', () => {
  const spec = { skew: { count: 2, maxDeltaMs: 5000 }, lost: { count: 1 }, duplicate: { count: 1 } };
  const original = base();
  const { events, log } = injectFaults(original, spec, 7);
  assert.deepEqual(replayInjections(original, log), events);
});

test('explicit skew shifts start and end by deltaMs', () => {
  const { events, log } = injectFaults(base(), { skew: [{ id: 'f', deltaMs: 50 }] });
  const f = events.find((e) => e.id === 'f');
  assert.deepEqual([f.start, f.end], [250, 350]);
  assert.deepEqual(log, [
    { op: 'skew', id: 'f', deltaMs: 50, before: { start: 200, end: 300 }, after: { start: 250, end: 350 } },
  ]);
});

test('lost fault removes the event from the stream', () => {
  const { events, log } = injectFaults(base(), { lost: ['f'] });
  assert.ok(!events.some((e) => e.id === 'f'));
  assert.equal(log[0].op, 'lost');
  assert.equal(log[0].removed.type, 'fault');
});

test('duplicate fault clones with a fresh id and same interval', () => {
  const { events } = injectFaults(base(), { duplicate: [{ id: 'f', times: 2 }] });
  const copies = events.filter((e) => e.id.startsWith('f#dup'));
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.start === 200 && c.end === 300 && c.type === 'fault'));
});

test('certificate embeds the injection record and verifies replay', () => {
  const cert = analyze(base(), {}, { injection: { spec: { skew: { count: 1 } }, seed: 9 } });
  assert.equal(cert.injection.seed, 9);
  assert.ok(Array.isArray(cert.injection.log));
  assert.equal(cert.injection.replayVerified, true);
});
