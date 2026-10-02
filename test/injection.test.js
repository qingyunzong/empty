import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, replay, ERR } from '../src/index.js';

const BASE = [
  { id: 'r', type: 'run', start: 0, end: 10_000 },
  { id: 'f', type: 'fault', start: 2000, end: 5000 },
];

test('acceptance 3: injected duplicate fault does not double-deduct OEE', () => {
  const base = analyze({ events: BASE });
  const dup = analyze({ events: BASE, injection: { seed: 7, duplicate: [{ id: 'f', times: 5 }] } });
  assert.equal(dup.ok, true);
  assert.deepEqual(dup.oee, base.oee);
  assert.deepEqual(dup.timeline, base.timeline);
  assert.deepEqual(dup.certificate.injection.duplicate, [{ id: 'f', times: 5 }]);
});

test('injection is replayable: certificate reproduces identical hashes', () => {
  const spec = { seed: 42, lost: 1, duplicate: 1, skew: { count: 1, maxDeltaMs: 500 } };
  const events = [
    { id: 'a', type: 'run', start: 0, end: 10_000 },
    { id: 'b', type: 'fault', start: 2000, end: 3000 },
    { id: 'c', type: 'idle', start: 5000, end: 6000 },
  ];
  const params = { maxSkewMs: Number.MAX_SAFE_INTEGER };
  const first = analyze({ events, params, injection: spec });
  assert.equal(first.ok, true);
  assert.ok(first.certificate.injection.lost.length <= 1);
  // replay from the certificate's resolved injection
  const rp = replay(first.certificate, events);
  assert.equal(rp.match, true);
  // same spec again -> identical output hash (deterministic seed)
  const second = analyze({ events, params, injection: spec });
  assert.equal(second.certificate.outputHash, first.certificate.outputHash);
});

test('lost injection removes the event and is visible in the certificate', () => {
  const r = analyze({ events: BASE, injection: { lost: ['f'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.certificate.injection.lost, ['f']);
  assert.equal(r.oee.unplannedDowntimeMs, 0);
  assert.equal(r.oee.availability, 1);
});

test('skew injection can push a stream past maxSkew -> ERR_CLOCK', () => {
  const r = analyze({
    events: BASE,
    params: { maxSkewMs: 1000 },
    injection: { skew: [{ id: 'f', deltaMs: -50_000 }] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERR.CLOCK);
});

test('overlapping duplicate with a fresh id still does not double count (union semantics)', () => {
  const r = analyze({
    events: [...BASE, { id: 'f-dup', type: 'fault', start: 2000, end: 5000 }],
  });
  const base = analyze({ events: BASE });
  assert.equal(r.oee.attribution.fault, base.oee.attribution.fault);
});
