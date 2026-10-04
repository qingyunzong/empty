import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { ingestEvents, recoverAndFinalize } from '../src/engine.js';
import { tmpdir, ev } from './helpers.mjs';

test('idempotent dedup: re-ingesting the same events applies nothing twice', () => {
  const store = new Store(tmpdir());
  const batch = [
    ev({ id: 'a', ts: 1, kind: 'quality.scan', payload: { result: 'pass', qty: 5 } }),
    ev({ id: 'b', ts: 2, kind: 'quality.hold', payload: {} }),
    ev({ id: 'c', ts: 3, kind: 'quality.release', payload: {} }),
  ];
  const r1 = ingestEvents(store, batch);
  assert.equal(r1.applied, 3);
  const r2 = ingestEvents(store, batch);
  assert.equal(r2.applied, 0);
  assert.equal(r2.duplicates, 3);
  assert.equal(store.state.lots.L1.total, 5); // scan qty applied exactly once
  assert.equal(store.state.lots.L1.transitions, 2); // hold + release exactly once
  assert.equal(store.state.stats.duplicates, 3);
});

test('duplicates inside one batch are collapsed', () => {
  const store = new Store(tmpdir());
  const r = ingestEvents(store, [ev({ id: 'x' }), ev({ id: 'x' }), ev({ id: 'y' })]);
  assert.equal(r.applied, 2);
  assert.equal(r.duplicates, 1);
});

test('out-of-order arrival within the window matches in-order result', () => {
  const ordered = [
    ev({ id: 's1', ts: 10, kind: 'quality.scan', payload: { result: 'pass', qty: 2 } }),
    ev({ id: 'h1', ts: 20, kind: 'quality.hold', payload: {} }),
    ev({ id: 'r1', ts: 30, kind: 'quality.release', payload: {} }),
    ev({ id: 'a1', ts: 40, kind: 'device.alarm', payload: {} }),
    ev({ id: 'c1', ts: 50, kind: 'device.clear', payload: {} }),
  ];
  const shuffled = [ordered[2], ordered[4], ordered[0], ordered[3], ordered[1]];
  const s1 = new Store(tmpdir());
  const s2 = new Store(tmpdir());
  ingestEvents(s1, ordered, { window: 60_000 });
  ingestEvents(s2, shuffled, { window: 60_000 });
  assert.deepEqual(s2.state.lots, s1.state.lots);
  assert.deepEqual(s2.state.devices, s1.state.devices);
  assert.equal(s2.state.watermark, s1.state.watermark);
});

test('illegal transitions are rejected with VALIDATION and do not mutate state', () => {
  const store = new Store(tmpdir());
  const r = ingestEvents(store, [
    ev({ id: 'r1', ts: 1, kind: 'quality.release', payload: {} }), // release while normal
    ev({ id: 'h1', ts: 2, kind: 'quality.hold', payload: {} }),
    ev({ id: 'h2', ts: 3, kind: 'quality.hold', payload: {} }),     // hold while held
    ev({ id: 'c1', ts: 4, kind: 'device.clear', payload: {} }),    // clear while ok
  ]);
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.every((e) => e.code === 'VALIDATION'));
  assert.equal(store.state.lots.L1.status, 'held');
  assert.equal(store.state.devices.PLC1.status, 'ok');
  assert.equal(store.state.stats.rejected, 3);
});

test('events older than watermark minus window are flagged late but still applied', () => {
  const store = new Store(tmpdir());
  ingestEvents(store, [ev({ id: 'now', ts: 100_000 })], { window: 1000 });
  const r = ingestEvents(store, [ev({ id: 'old', ts: 50_000, kind: 'quality.scan', payload: { result: 'pass', qty: 7 } })], { window: 1000 });
  assert.equal(r.applied, 1);
  assert.equal(store.state.stats.late, 1);
  assert.equal(store.state.lots.L1.total, 8); // nothing lost
});

test('scan with result=fail auto-holds the lot; repeated fail while held is a no-op', () => {
  const store = new Store(tmpdir());
  const r = ingestEvents(store, [
    ev({ id: 'f1', ts: 1, kind: 'quality.scan', payload: { result: 'fail' } }),
    ev({ id: 'f2', ts: 2, kind: 'quality.scan', payload: { result: 'fail' } }),
  ]);
  assert.equal(r.errors.length, 0);
  assert.equal(store.state.lots.L1.status, 'held');
  assert.equal(store.state.lots.L1.transitions, 1);
});
