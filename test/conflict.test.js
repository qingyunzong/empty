import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { ingestEvents } from '../src/engine.js';
import { buildCertificate } from '../src/cert.js';
import { tmpdir, ev } from './helpers.mjs';

test('concurrent manual release vs auto hold on same lot: safety-first hold, certified', () => {
  const store = new Store(tmpdir());
  const base = ev({ id: 's0', ts: 1, kind: 'quality.scan', payload: { result: 'pass' } });
  const autoHold = ev({ id: 'h1', ts: 2, kind: 'quality.hold', payload: { auto: true, deps: ['s0'] } });
  const manualRelease = ev({ id: 'r1', ts: 3, kind: 'quality.release', payload: { deps: ['s0'], by: 'operator-7' } });
  const r = ingestEvents(store, [base, autoHold, manualRelease]);

  assert.equal(store.state.lots.L1.status, 'held', 'concurrent hold/release resolves to held');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].reason, 'concurrent-hold-release');
  assert.deepEqual(r.conflicts[0].maximal.map((m) => m.id).sort(), ['h1', 'r1']);

  const cert = buildCertificate(store, 'L1');
  assert.equal(cert.status, 'held');
  assert.equal(cert.locked, true);
  assert.match(cert.explanation, /concurrent hold\/release/);
  assert.match(cert.explanation, /safety-first/);
  assert.equal(cert.causal.unknownAncestors.length, 0);
  assert.equal(cert.causal.cycle, false);
});

test('release that happens-after the hold wins (causal order respected)', () => {
  const store = new Store(tmpdir());
  ingestEvents(store, [
    ev({ id: 'h1', ts: 1, kind: 'quality.hold', payload: {} }),
    ev({ id: 'r1', ts: 2, kind: 'quality.release', payload: { deps: ['h1'] } }),
  ]);
  assert.equal(store.state.lots.L1.status, 'normal');
  const cert = buildCertificate(store, 'L1');
  assert.equal(cert.locked, false);
  assert.deepEqual(cert.causal.happensBefore, [{ before: 'h1', after: 'r1' }]);
});

test('hold that happens-after the release wins', () => {
  const store = new Store(tmpdir());
  ingestEvents(store, [
    ev({ id: 'h1', ts: 1, kind: 'quality.hold', payload: {} }),
    ev({ id: 'r1', ts: 2, kind: 'quality.release', payload: { deps: ['h1'] } }),
    ev({ id: 'h2', ts: 3, kind: 'quality.hold', payload: { auto: true, deps: ['r1'] } }),
  ]);
  assert.equal(store.state.lots.L1.status, 'held');
  assert.equal(store.state.conflicts.length, 0); // total causal order, no conflict
});

test('unknown ancestor sends the lot to pending, never failed', () => {
  const store = new Store(tmpdir());
  const r = ingestEvents(store, [
    ev({ id: 'h1', ts: 1, kind: 'quality.hold', payload: { deps: ['ghost'] } }),
  ]);
  assert.equal(store.state.lots.L1.status, 'pending');
  assert.deepEqual(r.pending, ['L1']);
  assert.equal(store.state.pending.L1.reason, 'unknown-ancestor');
  assert.ok(!r.errors.some((e) => e.code === 'VALIDATION' && /fail/i.test(e.message)));

  // the missing ancestor arrives later (e.g. via sync) -> pending resolves
  const r2 = ingestEvents(store, [ev({ id: 'ghost', ts: 0, kind: 'quality.scan', payload: { result: 'pass' } })]);
  assert.equal(store.state.lots.L1.status, 'held');
  assert.deepEqual(r2.pending, []);
  const cert = buildCertificate(store, 'L1');
  assert.equal(cert.status, 'held');
});

test('dependency cycle sends the lot to pending, never failed', () => {
  const store = new Store(tmpdir());
  const r = ingestEvents(store, [
    ev({ id: 'h1', ts: 1, kind: 'quality.hold', payload: { deps: ['r1'] } }),
    ev({ id: 'r1', ts: 2, kind: 'quality.release', payload: { deps: ['h1'] } }),
  ]);
  assert.equal(store.state.lots.L1.status, 'pending');
  assert.equal(store.state.pending.L1.reason, 'dependency-cycle');
  assert.deepEqual(r.pending, ['L1']);
  const cert = buildCertificate(store, 'L1');
  assert.equal(cert.locked, true);
  assert.match(cert.explanation, /dependency cycle/);
  assert.match(cert.explanation, /not failed/);
});

test('transitive happens-before: release depending on a scan that follows the hold is not a conflict', () => {
  const store = new Store(tmpdir());
  ingestEvents(store, [
    ev({ id: 'h1', ts: 1, kind: 'quality.hold', payload: {} }),
    ev({ id: 's1', ts: 2, kind: 'quality.scan', payload: { result: 'pass', deps: ['h1'] } }),
    ev({ id: 'r1', ts: 3, kind: 'quality.release', payload: { deps: ['s1'] } }),
  ]);
  assert.equal(store.state.lots.L1.status, 'normal');
  assert.equal(store.state.conflicts.length, 0);
});
