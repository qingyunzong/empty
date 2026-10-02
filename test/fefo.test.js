'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

// Acceptance 1: FEFO selection across QC windows, ties broken by batch id.

const CONFIG = {
  cmd: 'configure',
  timezones: { 'Asia/Shanghai': 480 },
  rules: [{ id: 'qc', kind: 'weekly', weekday: 1, start: '08:00', durationMinutes: 480, timezone: 'Asia/Shanghai' }],
  holidays: { cancel: [], add: [] },
};
// QC windows: Mondays 08:00-16:00 CST == 00:00-08:00 UTC.

function buildEngine() {
  const e = new Engine();
  e.execute(CONFIG);
  // B1 inspected in the week-1 window, latest expiry.
  e.execute({ cmd: 'receive', batch: 'B1', qty: 10, expiry: '2026-06-01T00:00:00Z', lot: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] });
  // B2/B3 inspected in the week-2 window, earlier (tied) expiry.
  e.execute({ cmd: 'receive', batch: 'B2', qty: 10, expiry: '2026-05-01T00:00:00Z', lot: ['2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z'] });
  e.execute({ cmd: 'receive', batch: 'B3', qty: 10, expiry: '2026-05-01T00:00:00Z', lot: ['2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z'] });
  for (const b of ['B1', 'B2', 'B3']) e.execute({ cmd: 'event', batch: b, type: 'available' });
  e.execute({ cmd: 'inspect', batch: 'B1', time: '2026-01-05T02:00:00Z', defects: [] });
  e.execute({ cmd: 'inspect', batch: 'B2', time: '2026-01-12T02:00:00Z', defects: [] });
  e.execute({ cmd: 'inspect', batch: 'B3', time: '2026-01-12T03:00:00Z', defects: [] });
  return e;
}

test('FEFO picks earliest expiry across windows; ties broken by batch id', () => {
  const e = buildEngine();
  const r1 = e.execute({ cmd: 'issue', id: 'ORD-1', qty: 15, time: '2026-01-13T00:00:00Z' });
  // B2 and B3 (week-2 window) beat B1 (week-1 window) due to earlier expiry;
  // B2 before B3 on the shared expiry instant.
  assert.deepEqual(r1.allocations, [{ batch: 'B2', qty: 10 }, { batch: 'B3', qty: 5 }]);
  const r2 = e.execute({ cmd: 'issue', id: 'ORD-2', qty: 10, time: '2026-01-13T01:00:00Z' });
  assert.deepEqual(r2.allocations, [{ batch: 'B3', qty: 5 }, { batch: 'B1', qty: 5 }]);
  const snap = e.execute({ cmd: 'snapshot' });
  assert.equal(snap.issuableTotal, 5);
});

test('undo returns stock and restore re-deducts the same allocations', () => {
  const e = buildEngine();
  e.execute({ cmd: 'issue', id: 'ORD-1', qty: 15, time: '2026-01-13T00:00:00Z' });
  const undone = e.execute({ cmd: 'undo', issue: 'ORD-1' });
  assert.equal(undone.status, 'undone');
  let snap = e.execute({ cmd: 'snapshot' });
  assert.equal(snap.issuableTotal, 30);
  const restored = e.execute({ cmd: 'restore', issue: 'ORD-1' });
  assert.equal(restored.status, 'applied');
  snap = e.execute({ cmd: 'snapshot' });
  assert.equal(snap.issuableTotal, 15);
  assert.equal(snap.batches.find((b) => b.id === 'B2').remaining, 0);
  assert.equal(snap.batches.find((b) => b.id === 'B3').remaining, 5);
});

test('restore fails with NEGATIVE_INVENTORY when stock was consumed meanwhile', () => {
  const e = buildEngine();
  e.execute({ cmd: 'issue', id: 'ORD-1', qty: 25, time: '2026-01-13T00:00:00Z' });
  e.execute({ cmd: 'undo', issue: 'ORD-1' });
  e.execute({ cmd: 'issue', id: 'ORD-2', qty: 25, time: '2026-01-13T01:00:00Z' });
  assert.throws(
    () => e.execute({ cmd: 'restore', issue: 'ORD-1' }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );
});

test('over-issuing is a NEGATIVE_INVENTORY error and deducts nothing', () => {
  const e = buildEngine();
  assert.throws(
    () => e.execute({ cmd: 'issue', id: 'ORD-X', qty: 31, time: '2026-01-13T00:00:00Z' }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );
  assert.equal(e.execute({ cmd: 'snapshot' }).issuableTotal, 30);
});

test('unknown batch and invalid state transitions are errors', () => {
  const e = buildEngine();
  assert.throws(() => e.execute({ cmd: 'event', batch: 'NOPE', type: 'available' }), (err) => err.code === 'UNKNOWN_BATCH');
  assert.throws(() => e.execute({ cmd: 'inspect', batch: 'NOPE', time: '2026-01-05T02:00:00Z' }), (err) => err.code === 'UNKNOWN_BATCH');
  assert.throws(() => e.execute({ cmd: 'event', batch: 'B1', type: 'release' }), (err) => err.code === 'INVALID_STATE');
});

test('inspection outside a QC window does not make a batch issuable', () => {
  const e = new Engine();
  e.execute(CONFIG);
  e.execute({ cmd: 'receive', batch: 'B1', qty: 5, expiry: '2026-06-01T00:00:00Z', lot: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] });
  e.execute({ cmd: 'event', batch: 'B1', type: 'available' });
  const r = e.execute({ cmd: 'inspect', batch: 'B1', time: '2026-01-06T02:00:00Z', defects: [] }); // Tuesday
  assert.equal(r.inWindow, false);
  assert.equal(r.issuable, false);
  assert.throws(
    () => e.execute({ cmd: 'issue', id: 'ORD-1', qty: 1, time: '2026-01-07T00:00:00Z' }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );
});
